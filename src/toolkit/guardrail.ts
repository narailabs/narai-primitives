/**
 * guardrail — connector-side rules for blocking dangerous Bash invocations,
 * reusable from any plugin's PreToolUse hook.
 *
 * This module supplies:
 *   - The data shapes for a guardrail manifest (one JSON file per connector
 *     under `plugin/hooks/guardrails.json`).
 *   - A loader that reads + validates a manifest from disk.
 *   - A matching engine extracted from db-agent-connector's db-guard hook
 *     so every consumer (the per-connector hooks AND the hub's unified hook)
 *     evaluates the same way.
 *
 * Best-effort by default: the engine fails open on parse errors, so the
 * default posture is not a security boundary. An opt-in fail-closed mode
 * (the NARAI_GATE_ENFORCEMENT env var / a manifest `enforcement` field,
 * applied by the PreToolUse dispatcher) turns parse and compile failures
 * into hard denies. Callers still handle missing/invalid manifests.
 */

import * as fs from "node:fs";

export interface GuardrailRule {
  /**
   * Match when the first whitespace-separated token of a Bash segment, after
   * stripping env-var prefixes and shell openers, has a basename in this list.
   */
  block_first_token_basename?: readonly string[];
  /**
   * Match when the first two tokens (joined by a single space) of a Bash
   * segment match one of these strings. Used for things like
   * `aws dynamodb` where the program is `aws` but only the dynamodb subcommand
   * should be blocked.
   */
  block_two_token_command?: readonly string[];
  /** Optional redirect/help string appended to the default deny message. */
  redirect?: string;
  /** Override the default deny message entirely. `${blocked}` is substituted with the matched token. */
  deny_message?: string;
}

export interface GuardrailManifest {
  /** Schema version. Always `1` for now. */
  version: 1;
  /** Source connector name; surfaces in deny messages. */
  name: string;
  rules: GuardrailRule[];
  /**
   * Optional opt-in enforcement posture for evaluating this manifest. When
   * "fail_closed", failures to evaluate a rule become hard denies. Defaults
   * to fail-open (best-effort) when absent. Applied by the PreToolUse
   * dispatcher together with the NARAI_GATE_ENFORCEMENT env var.
   */
  enforcement?: "fail_open" | "fail_closed";
}

export interface BlockMatch {
  manifest: GuardrailManifest;
  rule: GuardrailRule;
  /** What was matched, e.g. `"psql"` or `"aws dynamodb"`. */
  blockedToken: string;
  /** The original full command string from `tool_input.command`. */
  command: string;
}

const SHELLS = new Set<string>(["bash", "sh", "zsh", "ksh", "dash"]);

const CONTAINER_RUNTIMES = new Set<string>(["docker", "podman", "nerdctl"]);

// docker/podman/nerdctl exec|run flags that consume a following argument in
// their space-separated form (`--flag value`). The `--flag=value` form is
// handled separately (a single self-contained token). This list is the common,
// realistic set; an exotic value flag in space form not listed here can still
// shift the parser by one token (it then fails open, never closed) — best
// effort, consistent with this module's default posture.
const CONTAINER_FLAGS_WITH_ARG = new Set<string>([
  // identity / mounts / env / workdir / labels
  "-u", "--user", "-e", "--env", "--env-file", "-w", "--workdir",
  "-v", "--volume", "--volume-driver", "--volumes-from", "--mount", "--tmpfs",
  "--name", "--entrypoint", "-l", "--label", "--label-file", "--annotation",
  "-p", "--publish", "--expose", "-a", "--attach", "--cidfile", "--link",
  // network / dns / host
  "--network", "--net", "--network-alias", "-h", "--hostname", "--domainname",
  "--add-host", "--ip", "--ip6", "--mac-address",
  "--dns", "--dns-option", "--dns-search",
  // resources
  "-m", "--memory", "--memory-reservation", "--memory-swap", "--kernel-memory",
  "--cpus", "-c", "--cpu-shares", "--cpu-period", "--cpu-quota",
  "--cpuset-cpus", "--cpuset-mems", "--pids-limit", "--blkio-weight",
  "--shm-size", "--ulimit", "--gpus", "--device",
  // namespaces / security
  "--pid", "--ipc", "--uts", "--userns", "--cgroupns", "--cgroup-parent",
  "--group-add", "--security-opt", "--sysctl", "--cap-add", "--cap-drop",
  // lifecycle / runtime / exec
  "--detach-keys", "--restart", "--stop-signal", "--stop-timeout",
  "--pull", "--platform", "--runtime", "--isolation",
  // logging / health
  "--log-driver", "--log-opt",
  "--health-cmd", "--health-interval", "--health-retries",
  "--health-timeout", "--health-start-period",
]);

/**
 * Read a guardrail manifest JSON file from disk and validate its shape.
 * Throws on parse/validation errors; the caller is responsible for fail-open
 * behaviour in PreToolUse hooks (catch + ignore).
 */
export function loadGuardrailManifest(filePath: string): GuardrailManifest {
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse guardrail manifest at ${filePath}: ${(err as Error).message}`);
  }
  return validateManifest(parsed, filePath);
}

function validateManifest(value: unknown, filePath: string): GuardrailManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Guardrail manifest at ${filePath} must be a JSON object.`);
  }
  const obj = value as Record<string, unknown>;
  if (obj["version"] !== 1) {
    throw new Error(`Guardrail manifest at ${filePath} must have version: 1.`);
  }
  if (typeof obj["name"] !== "string" || obj["name"] === "") {
    throw new Error(`Guardrail manifest at ${filePath} must have a non-empty 'name'.`);
  }
  if (!Array.isArray(obj["rules"])) {
    throw new Error(`Guardrail manifest at ${filePath} must have a 'rules' array.`);
  }
  const rules: GuardrailRule[] = obj["rules"].map((r, i) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new Error(`Guardrail manifest at ${filePath}: rules[${i}] must be an object.`);
    }
    return r as GuardrailRule;
  });
  const manifest: GuardrailManifest = {
    version: 1,
    name: obj["name"] as string,
    rules,
  };
  if (obj["enforcement"] !== undefined) {
    if (obj["enforcement"] !== "fail_open" && obj["enforcement"] !== "fail_closed") {
      throw new Error(
        `Guardrail manifest at ${filePath}: 'enforcement' must be "fail_open" or "fail_closed".`,
      );
    }
    manifest.enforcement = obj["enforcement"];
  }
  return manifest;
}

/**
 * Walk a Bash command, including `&&`/`||`/`;`/`|` segments and nested
 * `bash -c "..."` invocations, and return the first matching block, or
 * null if nothing matches.
 */
export function findBlockingRule(
  command: string,
  manifests: readonly GuardrailManifest[],
  depth = 0,
): BlockMatch | null {
  if (depth > 3) return null;
  const segments = splitSegments(command);
  for (const seg of segments) {
    const cleaned = stripOpeners(stripEnvPrefix(seg));
    if (cleaned === "") continue;
    const tokens = tokenize(cleaned);
    if (tokens.length === 0) continue;
    const head = basename(tokens[0] ?? "");

    // Recurse into shell -c "..." subcommands.
    const nested = unwrapShellDashC(tokens);
    if (nested !== null) {
      const inner = findBlockingRule(nested, manifests, depth + 1);
      if (inner !== null) return inner;
      continue;
    }

    // Recurse into container / remote-exec wrappers (docker/podman/nerdctl
    // exec|run, kubectl exec … -- cmd). Strip the wrapper + its own flags +
    // the container/image/pod name, then re-scan the inner command head.
    const innerExec = unwrapContainerExec(tokens);
    if (innerExec !== null) {
      const inner = findBlockingRule(innerExec, manifests, depth + 1);
      if (inner !== null) return inner;
      continue;
    }

    // Two-token prefix match (e.g., "aws dynamodb"). Matched case-insensitively
    // so an uppercase variant (which resolves to the real binary on a
    // case-insensitive filesystem) cannot slip past; the original case is kept
    // in blockedToken for the deny message.
    if (tokens.length >= 2) {
      const twoToken = `${head} ${tokens[1] ?? ""}`;
      const twoTokenLc = twoToken.toLowerCase();
      for (const m of manifests) {
        for (const r of m.rules) {
          if (r.block_two_token_command?.some((e) => e.toLowerCase() === twoTokenLc)) {
            return { manifest: m, rule: r, blockedToken: twoToken, command };
          }
        }
      }
    }

    // First-token basename match (case-insensitive; see note above).
    const headLc = head.toLowerCase();
    for (const m of manifests) {
      for (const r of m.rules) {
        if (r.block_first_token_basename?.some((e) => e.toLowerCase() === headLc)) {
          return { manifest: m, rule: r, blockedToken: head, command };
        }
      }
    }
  }
  return null;
}

/** Compose the deny message — uses `rule.deny_message` if set, otherwise a default. */
export function defaultDenyMessage(match: BlockMatch): string {
  if (typeof match.rule.deny_message === "string" && match.rule.deny_message !== "") {
    return match.rule.deny_message.replace(/\$\{blocked\}/g, match.blockedToken);
  }
  const redirect = match.rule.redirect !== undefined && match.rule.redirect !== ""
    ? ` ${match.rule.redirect}`
    : "";
  return (
    `${match.manifest.name} guardrail: direct \`${match.blockedToken}\` invocation blocked.` +
    `${redirect} Do NOT bypass this guardrail by obfuscating the invocation — reformulate the intent.`
  );
}

// ── internal helpers (extracted from db-guard.mjs so every hook agrees) ──

function splitSegments(cmd: string): string[] {
  return cmd
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t !== "");
}

function basename(tok: string): string {
  const i = tok.lastIndexOf("/");
  return i === -1 ? tok : tok.slice(i + 1);
}

function stripEnvPrefix(segment: string): string {
  let s = segment.trimStart();
  if (s.startsWith("env ")) s = s.slice(4).trimStart();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    const m = s.match(/^\S+\s*/);
    if (m === null) break;
    s = s.slice(m[0].length);
  }
  return s;
}

function stripOpeners(segment: string): string {
  let s = segment.trimStart();
  while (s.length > 0) {
    const c = s[0];
    if (c === "(" || c === "{" || c === "!" || c === "`") {
      s = s.slice(1).trimStart();
    } else {
      break;
    }
  }
  return s;
}

function unwrapShellDashC(tokens: readonly string[]): string | null {
  if (tokens.length < 3) return null;
  const shell = basename(tokens[0] ?? "");
  if (!SHELLS.has(shell)) return null;
  const ci = tokens.indexOf("-c");
  if (ci === -1 || ci + 1 >= tokens.length) return null;
  let inner = tokens.slice(ci + 1).join(" ").trim();
  inner = inner.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return inner;
}

function unwrapContainerExec(tokens: readonly string[]): string | null {
  const head = basename(tokens[0] ?? "").toLowerCase();
  const sub = (tokens[1] ?? "").toLowerCase();

  // kubectl exec [flags] <pod> [-c container] -- cmd args...
  if (head === "kubectl" && sub === "exec") {
    const sep = tokens.indexOf("--");
    if (sep === -1 || sep + 1 >= tokens.length) return null;
    return tokens.slice(sep + 1).join(" ").trim();
  }

  // docker / podman / nerdctl  exec|run  [flags] <container|image> cmd args...
  if (!CONTAINER_RUNTIMES.has(head)) return null;
  if (sub !== "exec" && sub !== "run") return null;

  let i = 2;
  // Skip the wrapper's own flags. Flags that take a separate arg consume the
  // next token; `--key=value` and bare boolean flags (-i, -t, -d, …) do not.
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("-")) break;             // reached container/image name
    if (t.includes("=")) { i += 1; continue; } // --env=FOO=bar form
    if (CONTAINER_FLAGS_WITH_ARG.has(t)) { i += 2; continue; }
    i += 1;                                     // boolean flag (-i, -t, -d, …)
  }
  // tokens[i] is the container/image name; the inner command starts after it.
  if (i + 1 >= tokens.length) return null;
  return tokens.slice(i + 1).join(" ").trim();
}
