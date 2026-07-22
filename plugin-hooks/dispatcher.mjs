#!/usr/bin/env node
/**
 * Shared PreToolUse / PostToolUse / SessionStart / SessionEnd dispatcher
 * for narai-primitives builtin Claude Code plugins.
 *
 * Usage:
 *   node dispatcher.mjs <event>
 *
 * Where <event> is one of: session-start, pre-tool-use, post-tool-use,
 * session-end. Reads ${CLAUDE_PLUGIN_ROOT}/plugin-config.json for the
 * plugin's identity and routes to the appropriate handler.
 *
 * Best-effort: handler-internal failures are logged to stderr but do not
 * block tool execution. Argument / configuration errors exit with a
 * non-zero code so Claude Code surfaces them to the operator.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePluginConfig } from "./plugin-config.mjs";
import {
  auditMemoEvent,
  memoActive,
  memoHandleAsk,
  memoHandlePostToolUse,
} from "./memo.mjs";

const VALID_EVENTS = new Set([
  "session-start",
  "pre-tool-use",
  "post-tool-use",
  "session-end",
]);

// Only run main() when invoked as a CLI, not when imported by tests.
// Resolve symlinks on both sides so the smart-bootstrap dedup path
// (where `node_modules/narai-primitives` is symlinked from a sibling
// plugin) still recognizes itself as the CLI entrypoint.
const isMainScript = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    const realArgv = fs.realpathSync(process.argv[1]);
    const realSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    return realArgv === realSelf;
  } catch {
    // Fall back to literal comparison if realpath can't resolve.
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})();

if (isMainScript) {
  main().catch((err) => {
    process.stderr.write(`dispatcher: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

async function main() {
  const event = process.argv[2];
  if (!VALID_EVENTS.has(event)) {
    process.stderr.write(
      `dispatcher: unknown event '${event}' (expected one of ${[...VALID_EVENTS].join(", ")})\n`,
    );
    process.exit(2);
  }

  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) {
    process.stderr.write("dispatcher: CLAUDE_PLUGIN_ROOT not set\n");
    process.exit(2);
  }

  const cfgPath = path.join(root, "plugin-config.json");
  if (!fs.existsSync(cfgPath)) {
    process.stderr.write(`dispatcher: missing ${cfgPath}\n`);
    process.exit(2);
  }
  const cfg = parsePluginConfig(fs.readFileSync(cfgPath, "utf-8"));

  switch (event) {
    case "session-start":
      await onSessionStart(cfg);
      break;
    case "pre-tool-use":
      await onPreToolUse(cfg);
      break;
    case "post-tool-use":
      await onPostToolUse(cfg);
      break;
    case "session-end":
      await onSessionEnd(cfg);
      break;
  }
  process.exit(0);
}

async function loadToolkit() {
  const { existsSync } = fs;
  const { homedir } = await import("node:os");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 1. Bundled: dispatcher at narai-primitives/plugin-hooks/; toolkit at narai-primitives/dist/toolkit/guardrail.js
    path.join(__dirname, "..", "dist", "toolkit", "guardrail.js"),
    // 2. Claude Code plugin install
    process.env.CLAUDE_PLUGIN_DATA
      ? path.join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "narai-primitives", "dist", "toolkit", "guardrail.js")
      : null,
  ].filter((p) => p !== null);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return await import(pathToFileURL(p).href);
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Lazily load the db audit module from dist. Returns the module namespace
 * ({ enableAudit, logEvent, scrubSqlSecrets, ... }) or null if unavailable.
 * Only used when NARAI_AUDIT_PATH is set, so the common path stays cheap.
 */
async function loadAudit() {
  const { existsSync } = fs;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(__dirname, "..", "dist", "connectors", "db", "lib", "audit.js"),
    process.env.CLAUDE_PLUGIN_DATA
      ? path.join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "narai-primitives", "dist", "connectors", "db", "lib", "audit.js")
      : null,
  ].filter((p) => p !== null);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return await import(pathToFileURL(p).href);
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Walk siblings of `pluginDataDir` looking for a `node_modules/narai-primitives`
 * at `wantedVersion`. Returns the matched node_modules path, or null if no
 * usable sibling found. Used to skip redundant npm install when N builtin
 * plugins are loaded in the same Claude Code session.
 */
export function findSiblingInstall(pluginDataDir, wantedVersion) {
  const parent = path.dirname(pluginDataDir);
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(parent, entry.name);
    if (candidate === pluginDataDir) continue;
    const pkgJson = path.join(
      candidate,
      "node_modules",
      "narai-primitives",
      "package.json",
    );
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
      if (meta.version === wantedVersion) {
        return path.join(candidate, "node_modules");
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function onSessionStart(cfg) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginRoot || !pluginData) return;

  await ensureBootstrap(pluginRoot, pluginData);

  // Best-effort: emit nudge banner if the toolkit is reachable.
  try {
    const reminderPath = path.join(
      pluginData,
      "node_modules",
      "narai-primitives",
      "dist",
      "toolkit",
      "plugin",
      "reminder.js",
    );
    if (fs.existsSync(reminderPath)) {
      // pathToFileURL is required on Windows — Node refuses raw absolute
      // paths as ESM specifiers (ERR_UNSUPPORTED_ESM_URL_SCHEME).
      const mod = await import(pathToFileURL(reminderPath).href);
      const decision = mod.evaluateNudge({ connectors: [cfg.name] });
      if (decision.nudge) process.stdout.write(decision.banner + "\n");
    }
  } catch (err) {
    process.stderr.write(`dispatcher: nudge failed (${err.message})\n`);
  }

  // Best-effort: stale-summarize.
  try {
    const stalePath = path.join(
      pluginData,
      "node_modules",
      "narai-primitives",
      "plugin-hooks",
      "stale-summarize.mjs",
    );
    if (fs.existsSync(stalePath)) {
      process.env.USAGE_CONNECTOR_NAME = cfg.name;
      await import(pathToFileURL(stalePath).href);
    }
  } catch (err) {
    process.stderr.write(`dispatcher: stale-summarize failed (${err.message})\n`);
  }
}

async function onPreToolUse(cfg) {
  const stdin = await readStdin();
  if (!stdin) return;
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    // Unparseable tool input: under fail-closed, deny rather than fall open.
    // No manifest to read here, so the posture comes from the env var or the
    // plugin-config default (cfg.enforcement).
    if (effectiveEnforcement(cfg.enforcement) === "fail_closed") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "fail-closed: unparseable tool input/command",
        },
      }));
    }
    return;
  }
  // Derive the tool being gated and the text to scan. Bash scans the
  // command; Write scans the file content; Edit scans the incoming text
  // (new_string only — old_string is the text being removed). `command`
  // therefore holds the candidate text for whichever tool fired.
  let scanTool;
  let command;
  if (payload.tool_name === "Bash") {
    scanTool = "Bash";
    command = payload.tool_input?.command;
  } else if (payload.tool_name === "Write") {
    scanTool = "Write";
    command = payload.tool_input?.content;
  } else if (payload.tool_name === "Edit") {
    scanTool = "Edit";
    command = payload.tool_input?.new_string;
  } else {
    return;
  }
  if (typeof command !== "string" || command.length === 0) return;

  const decisions = [];

  // 1. db-guard (Bash only; only if kind=db, and not opted out via user_config).
  //    The token-blocklist engine is command-shaped and meaningless for file content.
  if (scanTool === "Bash" && cfg.kind === "db" && process.env.DB_AGENT_GUARDRAILS !== "off") {
    const guardrailsPath = path.join(
      process.env.CLAUDE_PLUGIN_ROOT,
      "hooks",
      "guardrails.json",
    );
    if (fs.existsSync(guardrailsPath)) {
      // Cheap pre-read of the manifest's own `enforcement` field so the
      // engine-unavailable and engine-throw paths below can honor a
      // `fail_closed` declared by the manifest, not only the env var. If the
      // file itself will not parse, this stays undefined (env-only), matching
      // the documented "a fully corrupt manifest needs the env var" rule.
      let dbEnforcement;
      try {
        dbEnforcement = JSON.parse(fs.readFileSync(guardrailsPath, "utf-8")).enforcement;
      } catch {
        dbEnforcement = undefined;
      }
      try {
        const toolkit = await loadToolkit();
        if (toolkit && typeof toolkit.findBlockingRule === "function") {
          const { findBlockingRule, defaultDenyMessage, loadGuardrailManifest } = toolkit;
          const manifest = loadGuardrailManifest(guardrailsPath);
          const match = findBlockingRule(command, [manifest]);
          if (match) {
            decisions.push({
              decision: "deny",
              reason: defaultDenyMessage(match),
            });
          }
        } else if (effectiveEnforcement(dbEnforcement) === "fail_closed") {
          decisions.push({
            decision: "deny",
            reason: "fail-closed enforcement: db guardrail engine is unavailable",
          });
        }
      } catch (err) {
        process.stderr.write(`dispatcher: db-guard failed (${err.message})\n`);
        if (effectiveEnforcement(dbEnforcement) === "fail_closed") {
          decisions.push({
            decision: "deny",
            reason: `fail-closed enforcement: db guardrail manifest could not be evaluated (${err.message})`,
          });
        }
      }
    }
  }

  // 2. user-connector gates from $HOME and cwd. Mirror connector-gate.mjs:
  // honor NARAI_GATE_DISABLE (comma-separated rule names) so operators
  // can silence a noisy rule without editing gates.json.
  const disabled = new Set(
    (process.env.NARAI_GATE_DISABLE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // 3. plugin-shipped gates.json at CLAUDE_PLUGIN_ROOT/gates.json — lets
  // hook-only plugins (e.g. git-connector) ship default rules out-of-the-box.
  const pluginGatesFile = path.join(process.env.CLAUDE_PLUGIN_ROOT, "gates.json");
  if (fs.existsSync(pluginGatesFile)) {
    try {
      const gateCfg = JSON.parse(fs.readFileSync(pluginGatesFile, "utf-8"));
      applyGatesManifest(gateCfg, cfg.name, command, disabled, decisions, scanTool);
    } catch (err) {
      process.stderr.write(
        `dispatcher: plugin-root gate scan failed (${err.message})\n`,
      );
      if (effectiveEnforcement(cfg.enforcement) === "fail_closed") {
        decisions.push({
          decision: "deny",
          reason: `fail-closed enforcement: gates manifest at ${pluginGatesFile} could not be parsed`,
        });
      }
    }
  }

  // 4. user-connector gates from $HOME and cwd.
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  for (const root of [home, cwd]) {
    if (!root) continue;
    const gatesDir = path.join(root, ".connectors", "connectors");
    if (!fs.existsSync(gatesDir)) continue;
    let slugs;
    try {
      slugs = fs
        .readdirSync(gatesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const gatesFile = path.join(gatesDir, slug, "gates.json");
      if (!fs.existsSync(gatesFile)) continue;
      try {
        const gateCfg = JSON.parse(fs.readFileSync(gatesFile, "utf-8"));
        applyGatesManifest(gateCfg, slug, command, disabled, decisions, scanTool);
      } catch (err) {
        process.stderr.write(
          `dispatcher: gate scan failed for ${gatesFile} (${err.message})\n`,
        );
        if (effectiveEnforcement(cfg.enforcement) === "fail_closed") {
          decisions.push({
            decision: "deny",
            reason: `fail-closed enforcement: gates manifest at ${gatesFile} could not be parsed`,
          });
        }
      }
    }
  }

  if (decisions.length === 0) return;
  const rank = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision] - rank[a.decision]);
  const winner = decisions[0];

  // Ask-memoization ("approve once per workload"): when the winning decision
  // is an `ask` from a rule that opts in via a `memo` field AND a live grant
  // exists for the same gate + scope + session, replay the earlier approval
  // as an `allow`. Inert unless NARAI_MEMO_PATH is configured; every failure
  // mode falls through to the unchanged ask (fail-closed to asking). Denies
  // never consult the memo store.
  if (winner.decision === "ask" && winner.rule?.memo !== undefined && memoActive()) {
    let replay = null;
    try {
      replay = memoHandleAsk(winner.rule, payload, command);
    } catch (err) {
      process.stderr.write(`dispatcher: memo evaluation failed (${err.message})\n`);
      replay = null;
    }
    if (replay) {
      process.stdout.write(JSON.stringify(replay.output));
      try {
        await auditMemoEvent("guardrail_memo_replay", {
          tool: payload.tool_name,
          ...replay.audit,
        });
      } catch (err) {
        process.stderr.write(`dispatcher: memo audit failed (${err.message})\n`);
      }
      return;
    }
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: winner.decision,
      permissionDecisionReason: winner.reason,
    },
  }));

  // Best-effort audit of blocked/escalated decisions. Only runs when an
  // audit destination is configured, keeping the common allow path cheap.
  const auditPath = process.env.NARAI_AUDIT_PATH;
  if (auditPath && (winner.decision === "deny" || winner.decision === "ask")) {
    try {
      const audit = await loadAudit();
      if (audit && typeof audit.logEvent === "function") {
        audit.enableAudit(auditPath);
        const scrub = typeof audit.scrubSqlSecrets === "function"
          ? audit.scrubSqlSecrets
          : (s) => s;
        audit.logEvent({
          event_type: winner.decision === "deny" ? "guardrail_deny" : "guardrail_ask",
          details: { tool: payload.tool_name, command: scrub(command), reason: winner.reason },
        });
      }
    } catch (err) {
      process.stderr.write(`dispatcher: decision audit failed (${err.message})\n`);
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}
async function onPostToolUse(cfg) {
  // Ask-memoization bookkeeping: confirm a pending ask-approval into a grant
  // (the tool ran, so the operator approved the ask) and invalidate grants on
  // a branch switch. Only reads stdin when NARAI_MEMO_PATH is configured, so
  // existing deployments keep their exact stdin semantics for
  // usage-record.mjs (which reads fd 0 itself).
  let raw = null;
  if (memoActive()) {
    raw = await readStdin();
    if (raw) {
      try {
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
        if (payload !== null) {
          const events = memoHandlePostToolUse(payload);
          for (const ev of events) await auditMemoEvent(ev.type, ev.details);
        }
      } catch (err) {
        process.stderr.write(`dispatcher: memo post-tool-use failed (${err.message})\n`);
      }
    }
  }

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return;
  const usagePath = path.join(
    pluginData,
    "node_modules",
    "narai-primitives",
    "plugin-hooks",
    "usage-record.mjs",
  );
  if (!fs.existsSync(usagePath)) return;
  process.env.USAGE_CONNECTOR_NAME = cfg.name;
  if (cfg.binPath) process.env.USAGE_BIN_HINT = cfg.binPath;
  try {
    if (raw === null) {
      await import(pathToFileURL(usagePath).href);
    } else {
      // stdin was already consumed for memo bookkeeping; usage-record reads
      // fd 0 itself, so replay the captured payload through a subprocess.
      // process.execPath (not a literal "node") so bun-only hosts still work.
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync(process.execPath, [usagePath], {
        input: raw,
        stdio: ["pipe", "inherit", "inherit"],
        env: process.env,
      });
      if (res.error) {
        process.stderr.write(`dispatcher: usage-record failed (${res.error.message})\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`dispatcher: usage-record failed (${err.message})\n`);
  }
}
async function onSessionEnd(cfg) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return;
  const summaryPath = path.join(
    pluginData,
    "node_modules",
    "narai-primitives",
    "plugin-hooks",
    "session-summary.mjs",
  );
  if (!fs.existsSync(summaryPath)) return;
  // session-summary.mjs only runs its `main()` when it's the CLI entry
  // point (`import.meta.url === file://${process.argv[1]}`). Importing it
  // here would be a no-op; spawn it as a subprocess so the guard passes.
  try {
    const { spawnSync } = await import("node:child_process");
    spawnSync("node", [summaryPath], {
      stdio: "inherit",
      env: { ...process.env, USAGE_CONNECTOR_NAME: cfg.name },
    });
  } catch (err) {
    process.stderr.write(`dispatcher: session-summary failed (${err.message})\n`);
  }
}

/**
 * Ensure narai-primitives is installed in pluginData. Tries (in order):
 *   1. Skip if already installed at the right version.
 *   2. Symlink from a sibling plugin's node_modules.
 *   3. npm install in pluginData.
 *
 * Best-effort: all branches return without throwing. The caller proceeds
 * to side effects (nudge, stale-summarize, etc.) even when the install
 * is cached, so recurring per-session behavior fires every run.
 */
async function ensureBootstrap(pluginRoot, pluginData) {
  const rootPkg = path.join(pluginRoot, "package.json");
  if (!fs.existsSync(rootPkg)) return;
  let rootMeta;
  try {
    rootMeta = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
  } catch {
    return;
  }
  // Read the wanted narai-primitives version from the plugin's
  // `dependencies` block (e.g. `"^2.1.3"`) and strip the semver
  // prefix so the equality check matches the installed package's
  // resolved version field (e.g. `"2.1.3"`). The plugin's own
  // `version` is independent and not interchangeable.
  const depRange = rootMeta.dependencies?.["narai-primitives"];
  const wantVersion = depRange?.replace(/^[\^~>=< ]+/, "");
  if (!wantVersion) return;

  fs.mkdirSync(pluginData, { recursive: true });

  const myInstall = path.join(pluginData, "node_modules", "narai-primitives");
  if (fs.existsSync(myInstall)) {
    try {
      const installed = JSON.parse(
        fs.readFileSync(path.join(myInstall, "package.json"), "utf-8"),
      );
      if (installed.version === wantVersion) return;
    } catch {
      // Fall through to re-install.
    }
  }

  const sibling = findSiblingInstall(pluginData, wantVersion);
  if (sibling !== null) {
    try {
      const myNodeModules = path.join(pluginData, "node_modules");
      if (fs.existsSync(myNodeModules)) {
        fs.rmSync(myNodeModules, { recursive: true, force: true });
      }
      fs.symlinkSync(sibling, myNodeModules, "dir");
      return;
    } catch {
      // Fall through to install.
    }
  }

  fs.copyFileSync(rootPkg, path.join(pluginData, "package.json"));
  const { spawnSync } = await import("node:child_process");
  spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: pluginData,
    stdio: "inherit",
  });
}

/**
 * Resolve the effective enforcement posture from the global
 * NARAI_GATE_ENFORCEMENT env var and an optional manifest-level field.
 * Strictest wins: fail-closed if either requests it, else fail-open.
 */
export function effectiveEnforcement(manifestEnforcement) {
  const env = process.env.NARAI_GATE_ENFORCEMENT;
  if (env === "fail_closed" || manifestEnforcement === "fail_closed") {
    return "fail_closed";
  }
  return "fail_open";
}

/**
 * Expand the `__PROTECTED_BRANCHES__` token in a gate pattern into a
 * regex-escaped alternation of the default protected branches (main, master)
 * plus any names in the NARAI_GIT_PROTECTED_BRANCHES env var (comma-separated).
 * Operator-provided names are regex-escaped, so this cannot inject regex.
 * Patterns without the token are returned unchanged (backward compatible).
 */
export function expandPattern(pattern) {
  if (typeof pattern !== "string" || !pattern.includes("__PROTECTED_BRANCHES__")) {
    return pattern;
  }
  const extra = (process.env.NARAI_GIT_PROTECTED_BRANCHES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const branches = ["main", "master", ...extra];
  const escaped = branches.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return pattern.replace(/__PROTECTED_BRANCHES__/g, `(?:${escaped.join("|")})`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve optional case/flag controls for a pattern rule. Returns
// { flags } on success or { error: true } for an unknown flag (the caller
// fails closed). Backward compatible: a rule with neither field -> "".
// `g` and `y` are deliberately disallowed: the compiled regex is reused
// across every command segment, and a sticky/global flag carries `lastIndex`
// between `.test()` calls, so it would intermittently miss and fail open.
function resolveRuleFlags(rule) {
  let flags = typeof rule.flags === "string" ? rule.flags : "";
  if (flags && !/^[imsu]*$/.test(flags)) return { error: true };
  if (rule.ignore_case === true && !flags.includes("i")) flags += "i";
  return { flags };
}

// Turn a literal string into a case-insensitive regex fragment via character
// classes. Used for verbs and hostnames so the matcher needs no global `i`
// flag (which would wrongly conflate curl's case-sensitive `-X` method flag
// with `-x`, the proxy flag).
function ciFragment(s) {
  return s.replace(/[a-zA-Z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/**
 * Build a predicate `(segment) => boolean` for an `external_write` gate rule.
 * It fires when a state-changing HTTP request targets an allowlisted host, or
 * a configured write CLI subcommand appears. The host is matched at a real URL
 * host boundary — immediately after `scheme://` (and optional `userinfo@`),
 * consuming whole dotted labels and ending at a host delimiter — so an
 * allowlisted host cannot be spoofed via path, query, userinfo, subdomain
 * suffix (`atlassian.net.evil.com`) or label prefix (`evil-atlassian.net`).
 * Verbs cover curl `-X`/`--request`, wget `--method`, and HTTPie's positional
 * `http[s] VERB <url>` form. Throws on a malformed rule shape (so the caller
 * can fail closed).
 */
export function buildExternalWriteMatcher(rule) {
  const methods = rule.methods;
  const hosts = rule.allowed_hosts;
  const writeCli = rule.write_cli;
  if (
    !Array.isArray(methods) || methods.length === 0 ||
    !methods.every((m) => typeof m === "string" && m.length > 0)
  ) {
    throw new Error("external_write: 'methods' must be a non-empty string array");
  }
  if (
    !Array.isArray(hosts) ||
    !hosts.every((h) => typeof h === "string" && h.length > 0)
  ) {
    throw new Error("external_write: 'allowed_hosts' must be a string array");
  }
  if (
    writeCli !== undefined &&
    (!Array.isArray(writeCli) ||
      !writeCli.every((c) => typeof c === "string" && c.length > 0))
  ) {
    throw new Error("external_write: 'write_cli' must be a string array of subcommands");
  }
  const methodSet = new Set(methods.map((m) => String(m).toUpperCase()));
  const VERB = `(?:${methods.map((m) => ciFragment(escapeRe(m))).join("|")})`;
  const HOST = `(?:${hosts.map((h) => ciFragment(escapeRe(h))).join("|")})`;
  // Host matched at a real URL host position: at a token start, or after an
  // optional `scheme:/[/]` and optional `userinfo@`. curl accepts a missing
  // scheme (defaults to http) and a single slash; the LAST `@` delimits
  // userinfo. Whole dotted labels are consumed and a trailing FQDN dot is
  // tolerated, so an allowlisted host cannot be spoofed via path, query,
  // userinfo, a subdomain suffix (`atlassian.net.evil.com`), or a label prefix
  // (`evil-atlassian.net`).
  const SCHEME = `(?:[A-Za-z][A-Za-z0-9+.\\-]*:\\/{1,2})?`;
  const USER = `(?:[^/?#\\s'"]*@)?`;
  const SUB = `(?:[A-Za-z0-9\\-]+\\.)*`;
  const HOSTPART = `${SUB}${HOST}\\.?(?=[:/?#\\s'"]|$)`;
  // The host must start at a line/whitespace start or immediately after a quote
  // (with an optional scheme; curl accepts a scheme-less host, including quoted
  // `'atlassian.net/x'`). `=` is deliberately NOT a host-start delimiter, so a
  // bare allowlisted host appearing after `key=` in a query value or `-d` body
  // (`...?ref=atlassian.net`, `-d 'u=atlassian.net'`) does not read as the
  // request host — the quote there precedes `key`, not the host.
  const ANCHOR = `(?:^|[\\s'"])${SCHEME}`;
  const urlHostRe = new RegExp(`${ANCHOR}${USER}${HOSTPART}`);
  // Command names are matched case-insensitively (a case-insensitive
  // filesystem resolves `CURL`/`HTTP` to the real binary). The verb and data
  // flags below stay case-sensitive on purpose, so `-X` is not confused with
  // `-x` (proxy), nor `-d` with `-D` (dump-header), etc.
  const curlWgetRe = /\b(?:curl|wget)\b/i;
  // Explicit verb: curl `-X`/`--request`, wget `--method`. `-X` stays
  // case-sensitive so it is not confused with `-x` (curl's proxy flag); the
  // separator tolerates `=` (`-X=POST`) and a line-continuation backslash.
  const verbFlagRe = new RegExp(
    `(?:^|\\s)(?:-X[\\s=\\\\]*|--request[\\s=]+|--method[\\s=]+)${VERB}\\b`,
  );
  // curl/wget flags that imply a method even without an explicit verb.
  const postFlagRe =
    /(?:^|\s)(?:-d|-F|--data(?:-raw|-binary|-urlencode|-ascii)?|--form|--form-string|--json|--post-data|--post-file)\b/;
  const putFlagRe = /(?:^|\s)(?:-T|--upload-file)\b/;
  // HTTPie: a positional verb (optionally after flags), or an implicit POST
  // when a request carries a body data item (`key=value`, `key:=json`,
  // `key@file`, but not `key==query`).
  const httpieVerbRe = new RegExp(
    `^\\s*https?\\s+(?:-{1,2}\\S+\\s+)*${VERB}\\s+${SCHEME}${USER}${HOSTPART}`,
    "i",
  );
  const httpieCmdRe = /^\s*https?\s/i;
  const httpieItemRe = /(?:^|\s)[A-Za-z_][A-Za-z0-9_.\-]*(?::=|=(?!=)|@)/;
  const cliRes = (writeCli ?? []).map(
    (c) => new RegExp(`\\b${c.trim().split(/\s+/).map(escapeRe).join("\\s+")}\\b`),
  );
  return (segment) => {
    if (urlHostRe.test(segment)) {
      if (curlWgetRe.test(segment)) {
        if (verbFlagRe.test(segment)) return true;
        if (methodSet.has("POST") && postFlagRe.test(segment)) return true;
        if (methodSet.has("PUT") && putFlagRe.test(segment)) return true;
      }
      if (
        methodSet.has("POST") &&
        httpieCmdRe.test(segment) &&
        httpieItemRe.test(segment)
      ) return true;
    }
    if (httpieVerbRe.test(segment)) return true;
    for (const r of cliRes) if (r.test(segment)) return true;
    return false;
  };
}

/**
 * Apply a parsed gates.json manifest to a command. Rules with invalid
 * shape, disabled names, or uncompilable patterns are skipped. Anchored
 * patterns match per-segment so chaining (`echo ok; psql ...`) can't bypass.
 *
 * Under fail-closed enforcement (env var or the manifest's `enforcement`
 * field), a rule whose pattern will not compile (or whose external_write
 * shape is malformed) becomes a hard deny instead of being silently skipped
 * — we cannot prove the command is safe.
 */
export function applyGatesManifest(manifest, source, text, disabled, decisions, scanTool = "Bash") {
  const enforcement = effectiveEnforcement(manifest.enforcement);
  // Bash commands are split on chaining operators so anchored rules apply
  // per-segment. File content (Write/Edit) is matched as a single unit so
  // characters like `;` or `|` inside the file do not fragment it. If the
  // splitter throws on pathological input, fail closed denies rather than
  // silently skipping the command.
  let segments;
  try {
    segments = scanTool === "Bash" ? splitCompound(text) : [text];
  } catch {
    if (enforcement === "fail_closed") {
      decisions.push({
        decision: "deny",
        reason: `fail-closed enforcement: ${source} could not tokenize the command`,
      });
    }
    return;
  }
  for (const rule of manifest.rules ?? []) {
    if (!["deny", "ask", "allow"].includes(rule.decision)) continue;
    if (typeof rule.name === "string" && disabled.has(rule.name)) continue;
    // A rule applies to a tool only if listed in `applies_to`. Default is
    // Bash-only, so every existing rule keeps its current behavior and is
    // skipped on Write/Edit unless it explicitly opts in.
    const appliesTo = Array.isArray(rule.applies_to) ? rule.applies_to : ["Bash"];
    if (!appliesTo.includes(scanTool)) continue;

    // A rule is either a declarative `external_write` (host-allowlist) rule or
    // a `pattern` (regex) rule. Both reduce to a `(segment) => boolean` matcher.
    let matchFn;
    if (rule.type === "external_write") {
      try {
        matchFn = buildExternalWriteMatcher(rule);
      } catch {
        if (enforcement === "fail_closed") {
          decisions.push({
            decision: "deny",
            reason: `fail-closed enforcement: ${source} external-write rule '${rule.name ?? "rule"}' is malformed`,
          });
        }
        continue;
      }
    } else {
      if (typeof rule.pattern !== "string") continue;
      const fr = resolveRuleFlags(rule);
      if (fr.error) {
        if (enforcement === "fail_closed") {
          decisions.push({
            decision: "deny",
            reason: `fail-closed enforcement: ${source} gate rule '${rule.name ?? "rule"}' has unknown regex flags`,
          });
        }
        continue;
      }
      let re;
      try { re = new RegExp(expandPattern(rule.pattern), fr.flags); } catch {
        if (enforcement === "fail_closed") {
          decisions.push({
            decision: "deny",
            reason: `fail-closed enforcement: ${source} gate rule '${rule.name ?? "rule"}' has an invalid pattern`,
          });
        }
        continue;
      }
      matchFn = (segment) => re.test(segment);
    }

    for (const segment of segments) {
      if (matchFn(segment)) {
        decisions.push({
          decision: rule.decision,
          reason: rule.reason ?? `${source} gate: ${rule.name ?? "rule"}`,
          // Carried so ask-memoization (memo.mjs) can read the winning
          // rule's optional `memo` config; inert everywhere else.
          rule,
        });
        break;
      }
    }
  }
}

/**
 * Split a bash command on chaining operators so anchored gate rules
 * apply per-segment. Mirrors connector-gate.mjs's behavior.
 */
function splitCompound(cmd) {
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts
    .map((p) => stripPrefix(p.trim()))
    .filter((p) => p.length > 0);
}

function stripPrefix(s) {
  let cur = s;
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cur)) {
    cur = cur.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return cur.replace(/^(sudo|nice|time)\s+/, "");
}
