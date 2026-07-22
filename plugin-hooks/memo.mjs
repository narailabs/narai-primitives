#!/usr/bin/env node
/**
 * Ask-memoization for gate rules ("approve once per workload").
 *
 * A gate rule may carry an optional `memo` field:
 *
 *   { "name": "push", "decision": "ask", "pattern": "git\\s+push",
 *     "memo": { "scope": "repo_branch", "idle_minutes": 30, "max_hours": 8 } }
 *
 * When the dispatcher's PreToolUse winner is an `ask` from such a rule and a
 * LIVE grant exists for the same gate + scope + session, the ask is replayed
 * as an `allow` (announced to the operator via `systemMessage`). A grant is
 * created only after a real approval: the PreToolUse miss records a PENDING
 * entry, and the PostToolUse hook — which fires only if the tool actually ran,
 * i.e. the operator approved the ask — promotes it to a grant.
 *
 * Workload model (what makes a grant LIVE):
 *   - scope identity is primary: `repo_branch` keys a grant to
 *     repo toplevel + remote + branch, so different branches are independent
 *     grants by construction; `exact_command` keys to the literal command.
 *   - freshness is a sliding idle window: a grant expires `idle_minutes`
 *     after its LAST memoized use (every replay refreshes `last_used_at`),
 *     not on an absolute timer.
 *   - deterministic invalidation: a `git checkout`/`git switch` observed on
 *     PostToolUse drops the repo's grants for branches other than the
 *     now-current one; grants are session-keyed so session end drops all;
 *     scope re-resolution at replay time means an unobserved branch switch
 *     can never fire a stale grant.
 *   - `max_hours` is an outer backstop from grant time (default 8h).
 *
 * Activation mirrors NARAI_AUDIT_PATH: memoization is inert unless
 * NARAI_MEMO_PATH points at a writable state directory. NARAI_MEMO_DISABLE=1
 * is the kill switch. With no grants on disk the dispatcher's output is
 * byte-identical to the non-memoized behavior (fail-closed to asking).
 *
 * CLI (revocation / inspection):
 *   node memo.mjs clear    remove every pending + grant (audited)
 *   node memo.mjs status   print grants as JSONL
 *   node memo.mjs prune    drop expired pendings and stale grants
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PENDING_TTL_MS = 15 * 60 * 1000;
const GRANT_SWEEP_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_MAX_HOURS = 8;
const VALID_SCOPES = new Set(["repo_branch", "exact_command"]);
/** Grant recording is trusted only in modes where an `ask` decision produced
 * a real human prompt. bypassPermissions / dontAsk / auto can execute a tool
 * without a click, so execution there does not prove approval. An absent
 * field (older clients) is treated as the default interactive mode. */
const GRANTABLE_MODES = new Set(["default", "acceptEdits", "plan"]);

/**
 * Resolve the active memo state directory, or null when memoization is off
 * (no NARAI_MEMO_PATH, or NARAI_MEMO_DISABLE set). Mirrors how
 * NARAI_AUDIT_PATH activates auditing: unset means fully inert.
 */
export function memoActive() {
  if (process.env.NARAI_MEMO_DISABLE) return null;
  const dir = process.env.NARAI_MEMO_PATH;
  if (typeof dir !== "string" || dir.length === 0) return null;
  return dir;
}

/**
 * Validate and normalize a rule's `memo` field. Returns
 * { scope, idleMs, maxMs, idleMinutes, maxHours } or null when the shape is
 * invalid (fail-closed: an invalid memo config just means the ask stays an
 * ask).
 */
export function normalizeMemoConfig(memo) {
  if (typeof memo !== "object" || memo === null || Array.isArray(memo)) return null;
  const scope = memo.scope;
  if (!VALID_SCOPES.has(scope)) return null;
  const idle = memo.idle_minutes === undefined ? DEFAULT_IDLE_MINUTES : memo.idle_minutes;
  const max = memo.max_hours === undefined ? DEFAULT_MAX_HOURS : memo.max_hours;
  if (typeof idle !== "number" || !Number.isFinite(idle) || idle <= 0) return null;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return null;
  return {
    scope,
    idleMinutes: idle,
    maxHours: max,
    idleMs: idle * 60 * 1000,
    maxMs: max * 60 * 60 * 1000,
  };
}

function sha256(s) {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) so a crashed writer never leaves a half
 * record for the fail-closed reader to trip on. Store dirs/files are
 * owner-only: a grant file is a standing promptless-approval, so it gets
 * the same on-disk posture as a credential. */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function grantsDir(dir) {
  return path.join(dir, "grants");
}
function pendingDir(dir) {
  return path.join(dir, "pending");
}

export function grantFilePath(dir, gate, scopeKey) {
  return path.join(grantsDir(dir), `${slug(gate)}.${sha256(scopeKey).slice(0, 16)}.json`);
}

function pendingFilePath(dir, sessionId, command) {
  return path.join(
    pendingDir(dir),
    `${slug(sessionId)}.${sha256(command).slice(0, 16)}.json`,
  );
}

/**
 * Shell metacharacters that make a `cd` target or `git -C` path
 * non-literal. A path containing any of these cannot be resolved from the
 * command text alone, so scope resolution fails closed.
 */
const UNSAFE_PATH = /[$`*?<>|;&(){}[\]"'\\\n]/;

function cleanPathToken(tok) {
  let t = tok.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    t = t.slice(1, -1);
  }
  if (t.length === 0 || UNSAFE_PATH.test(t)) return null;
  if (t === "~") t = process.env.HOME ?? t;
  else if (t.startsWith("~/")) t = path.join(process.env.HOME ?? "~", t.slice(2));
  return t;
}

/** Strip leading env assignments and benign wrappers, mirroring the
 * dispatcher's stripPrefix, so segment-start-anchored matching below agrees
 * with how gates see the segment. */
function stripLead(s) {
  let cur = s;
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cur)) {
    cur = cur.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return cur.replace(/^(sudo|nice|time)\s+/, "");
}

/**
 * Determine the effective working directory for the first segment matching
 * `segmentRe` (tested against the prefix-stripped segment, so patterns can
 * anchor at `^git` — a gate false-positive like `echo git push` must never
 * resolve a scope), starting from `startCwd` and tracking literal `cd <path>`
 * segments before it (plus an inline `git -C <path>`). Segments are split on
 * chaining operators AND newlines — a hook payload command is often a
 * newline-separated script. Returns { dir, segment } or null when the
 * directory cannot be determined literally (fail-closed).
 */
export function effectiveDirFor(command, startCwd, segmentRe) {
  const segments = command.split(/(?:&&|\|\||;|\||\n)/);
  let dir = startCwd;
  for (const rawSeg of segments) {
    const seg = stripLead(rawSeg.trim());
    if (seg.length === 0) continue;
    if (segmentRe.test(seg)) {
      const c = /(?:^|[^A-Za-z0-9_])git\s+-C\s+(\S+)/.exec(seg);
      if (c) {
        const p = cleanPathToken(c[1]);
        if (p === null) return null;
        dir = path.resolve(dir ?? process.cwd(), p);
      }
      if (dir === null) return null;
      return { dir, segment: seg };
    }
    const m = /^cd\s+(.*)$/.exec(seg);
    if (m) {
      const p = cleanPathToken(m[1]);
      if (p === null) {
        dir = null; // poisoned: a later dependent segment fails closed
        continue;
      }
      dir = path.resolve(dir ?? process.cwd(), p);
    }
  }
  return null;
}

function gitOut(dir, args) {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** The only push flags a memoized scope may look through: they change how
 * the push reports itself, never which refs go where. Every other flag —
 * `--force*`, `--delete`, `--tags`, `--all`, `--mirror`, `--prune`,
 * `--repo`, `-o`, and anything unknown — turns the command into a different
 * intent from the granted branch push, so parsing fails closed and the
 * operator is asked. None of these take a value, so any `=` form is also
 * rejected. */
const SCOPE_NEUTRAL_PUSH_FLAGS = new Set([
  "-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose",
  "--porcelain", "--progress", "--no-progress",
]);

/**
 * Parse the remote + refspec out of a `git push` segment. Returns
 * { remote, refspec } (refspec null when absent) or null when the segment
 * cannot be parsed confidently — unknown shapes fail closed. Refspecs that
 * are not a plain branch name (`:branch` deletes, `+branch` forces,
 * `src:dst` maps, wildcards) and flags outside the scope-neutral whitelist
 * return null on purpose: those are distinct intents that must never ride
 * a plain-push grant.
 */
export function parsePushTarget(segment) {
  const m = /^git\s+(?:-C\s+\S+\s+)?push\b(.*)$/.exec(stripLead(segment.trim()));
  if (!m) return null;
  const rest = m[1].trim();
  const tokens = rest.length === 0 ? [] : rest.split(/\s+/);
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("-")) {
      if (tok.includes("=") || !SCOPE_NEUTRAL_PUSH_FLAGS.has(tok)) return null;
      continue;
    }
    // Redirections / descriptors are not push arguments.
    if (/^[0-9]*[<>]/.test(tok) || tok === "2>&1") continue;
    positional.push(tok);
  }
  if (positional.length > 2) return null;
  const remote = positional[0] ?? "origin";
  const refspec = positional[1] ?? null;
  if (!/^[A-Za-z0-9._@:\/~-]+$/.test(remote)) return null;
  if (refspec !== null && !/^[A-Za-z0-9._\/-]+$/.test(refspec)) return null;
  return { remote, refspec };
}

/**
 * Resolve a memo scope key for a command. Returns
 * { key, detail, repo, branch } (repo/branch only for repo_branch) or null
 * when the scope cannot be established (non-git cwd, detached HEAD,
 * non-literal paths, unparseable push target, ...) — every failure means
 * "do not memoize", never "guess".
 */
export function resolveScope(scope, command, cwd) {
  if (scope === "exact_command") {
    return {
      key: `exact_command:${sha256(command)}`,
      detail: "this exact command",
    };
  }
  if (scope !== "repo_branch") return null;
  // A command that itself moves HEAD — `git checkout`/`git switch` in any
  // segment (e.g. `git switch other && git push`) — makes the pre-tool-use
  // branch resolution meaningless: the push would run on the post-switch
  // branch while the grant lookup used the pre-switch one. Fail closed;
  // such a compound command always asks (and never arms a grant).
  if (/\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\b/.test(command)) return null;
  // Anchored at segment start (post prefix-strip): only a segment that IS a
  // git push can establish a push workload scope. A gate that fires on a
  // substring false-positive (e.g. `echo git push`) stays a plain ask and
  // can never arm a grant.
  const pushRe = /^git\s+(?:-C\s+\S+\s+)?push\b/;
  const eff = effectiveDirFor(command, cwd, pushRe);
  if (!eff) return null;
  const target = parsePushTarget(eff.segment);
  if (!target) return null;
  const repo = gitOut(eff.dir, ["rev-parse", "--show-toplevel"]);
  if (!repo) return null;
  let branch = target.refspec;
  // A symbolic HEAD refspec ("git push origin HEAD") names whatever branch is
  // checked out at run time; keying a grant on the literal string would make
  // it branch-blind (it would survive an unobserved branch switch — and the
  // push it approves could then land on any branch). Treat it exactly like
  // the no-refspec form: resolve against the live repository on every call.
  if (branch !== null && branch.toUpperCase() === "HEAD") branch = null;
  if (branch === null) {
    const head = gitOut(eff.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!head || head === "HEAD") return null; // detached HEAD: no workload identity
    branch = head;
  }
  return {
    key: `repo_branch:${repo}\u0001${target.remote}\u0001${branch}`,
    detail: `branch '${branch}' -> ${target.remote} (repo ${path.basename(repo)})`,
    repo,
    remote: target.remote,
    branch,
  };
}

function isLive(grant, cfg, sessionId, scopeKey, gate, now) {
  return (
    grant !== null &&
    grant.gate === gate &&
    grant.scope_key === scopeKey &&
    grant.session_id === sessionId &&
    typeof grant.granted_at === "number" &&
    typeof grant.last_used_at === "number" &&
    now - grant.last_used_at < cfg.idleMs &&
    now - grant.granted_at < cfg.maxMs
  );
}

function fmtClock(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * PreToolUse hook point. Called by the dispatcher when the winning decision
 * is an `ask` from a rule carrying a `memo` field. Returns
 * { output, audit } for a memoized replay (the dispatcher emits `output`
 * instead of the ask), or null to keep the ask unchanged — in which case a
 * pending record has been written so PostToolUse can promote an approval
 * into a grant. All failure modes return null.
 */
export function memoHandleAsk(rule, payload, command) {
  const dir = memoActive();
  if (!dir) return null;
  const cfg = normalizeMemoConfig(rule.memo);
  if (!cfg) return null;
  const gate = typeof rule.name === "string" && rule.name.length > 0 ? rule.name : null;
  if (!gate) return null;
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0
    ? payload.session_id
    : null;
  if (!sessionId) return null;
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const scope = resolveScope(cfg.scope, command, cwd);
  if (!scope) return null;

  pruneMemoDir(dir);

  const now = Date.now();
  const gfile = grantFilePath(dir, gate, scope.key);
  const grant = readJson(gfile);
  if (isLive(grant, cfg, sessionId, scope.key, gate, now)) {
    const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
    writeJsonAtomic(gfile, {
      ...grant,
      last_used_at: now,
      turn_at_last_use: promptId ?? grant.turn_at_last_use ?? null,
    });
    const grantedClock = fmtClock(grant.granted_at);
    const reason =
      `memoized approval: '${gate}' auto-approved for ${scope.detail} — ` +
      `approved by the operator at ${grantedClock} this session; ` +
      `expires ${cfg.idleMinutes} min after last use. ` +
      `Revoke with 'memo clear' or by saying "revoke memoized approvals".`;
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
          additionalContext:
            `This gated action was auto-approved from the operator's earlier in-session ` +
            `approval (${scope.detail}, approved ${grantedClock}). Tell the operator it ran ` +
            `under that approval, and that saying "revoke memoized approvals" re-arms the gate.`,
        },
        systemMessage:
          `memo: auto-approved '${gate}' for ${scope.detail} ` +
          `(approved ${grantedClock}; idles out ${cfg.idleMinutes} min after last use). ` +
          `Say "revoke memoized approvals" to re-arm.`,
      },
      audit: {
        gate,
        scope: scope.key,
        granted_at: grant.granted_at,
        last_used_at: now,
        turn_at_last_use: promptId ?? grant.turn_at_last_use ?? null,
      },
    };
  }

  // Miss: leave the ask untouched, but remember it so an approval (proved by
  // PostToolUse firing) becomes a grant.
  writeJsonAtomic(pendingFilePath(dir, sessionId, command), {
    gate,
    scope_key: scope.key,
    scope_detail: scope.detail,
    ...(scope.repo !== undefined
      ? { repo: scope.repo, remote: scope.remote, branch: scope.branch }
      : {}),
    session_id: sessionId,
    created_at: now,
    prompt_id: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
  });
  return null;
}

/**
 * PostToolUse hook point. Two duties:
 *   (a) confirm — a pending record matching this session + exact command
 *       means the gated command actually executed, i.e. the operator
 *       approved the ask (hook asks cannot be silenced by allowlists);
 *       promote it to a grant unless the permission mode could have skipped
 *       the prompt.
 *   (b) invalidate — a `git checkout` / `git switch` is a context switch:
 *       drop the repo's grants for branches other than the now-current one.
 * Returns audit events: [{ type, details }].
 */
export function memoHandlePostToolUse(payload) {
  const dir = memoActive();
  if (!dir) return [];
  if (payload.tool_name !== "Bash") return [];
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return [];
  const events = [];

  // (a) confirm
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  if (sessionId) {
    const pfile = pendingFilePath(dir, sessionId, command);
    const pending = readJson(pfile);
    if (pending !== null) {
      try { fs.rmSync(pfile, { force: true }); } catch { /* best-effort */ }
      const now = Date.now();
      const mode = payload.permission_mode;
      const modeOk = mode === undefined || GRANTABLE_MODES.has(mode);
      const fresh = typeof pending.created_at === "number" &&
        now - pending.created_at < PENDING_TTL_MS;
      if (modeOk && fresh && pending.session_id === sessionId) {
        const grant = {
          gate: pending.gate,
          scope_key: pending.scope_key,
          scope_detail: pending.scope_detail ?? null,
          ...(pending.repo !== undefined
            ? { repo: pending.repo, remote: pending.remote, branch: pending.branch }
            : {}),
          session_id: sessionId,
          granted_at: now,
          last_used_at: now,
          turn_at_last_use: pending.prompt_id ?? null,
        };
        writeJsonAtomic(grantFilePath(dir, pending.gate, pending.scope_key), grant);
        events.push({
          type: "guardrail_memo_granted",
          details: {
            gate: pending.gate,
            scope: pending.scope_key,
            granted_at: now,
          },
        });
      }
    }
  }

  // (b) invalidate on branch switch
  const switchRe = /^git\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\b/;
  if (command.split(/(?:&&|\|\||;|\||\n)/).some((s) => switchRe.test(stripLead(s.trim())))) {
    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd();
    const eff = effectiveDirFor(command, cwd, switchRe);
    if (eff) {
      const repo = gitOut(eff.dir, ["rev-parse", "--show-toplevel"]);
      const head = gitOut(eff.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (repo && head) {
        for (const g of listGrants(dir)) {
          if (g.grant.repo === repo && g.grant.branch !== head && g.grant.branch !== undefined) {
            try { fs.rmSync(g.file, { force: true }); } catch { continue; }
            events.push({
              type: "guardrail_memo_invalidated",
              details: {
                gate: g.grant.gate,
                scope: g.grant.scope_key,
                cause: `branch switch to '${head}'`,
              },
            });
          }
        }
      }
    }
  }

  pruneMemoDir(dir);
  return events;
}

/** Enumerate grant files as [{ file, grant }]; unreadable files skipped. */
export function listGrants(dir) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(grantsDir(dir));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(grantsDir(dir), name);
    const grant = readJson(file);
    if (grant !== null) out.push({ file, grant });
  }
  return out;
}

/** Remove every pending and grant. Returns audit events for dropped grants. */
export function clearGrants(dir, cause = "revoked by operator") {
  const events = [];
  for (const g of listGrants(dir)) {
    try { fs.rmSync(g.file, { force: true }); } catch { continue; }
    events.push({
      type: "guardrail_memo_invalidated",
      details: { gate: g.grant.gate, scope: g.grant.scope_key, cause },
    });
  }
  try { fs.rmSync(pendingDir(dir), { recursive: true, force: true }); } catch { /* best-effort */ }
  return events;
}

/** Drop expired pendings and grants no client would ever replay again. Real
 * liveness (idle window, backstop) is enforced at replay against the CURRENT
 * rule config; this sweep only keeps the state dir from accumulating. */
export function pruneMemoDir(dir) {
  const now = Date.now();
  let pnames = [];
  try {
    pnames = fs.readdirSync(pendingDir(dir));
  } catch { /* no pending dir yet */ }
  for (const name of pnames) {
    const file = path.join(pendingDir(dir), name);
    const rec = readJson(file);
    if (rec === null || typeof rec.created_at !== "number" || now - rec.created_at >= PENDING_TTL_MS) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    }
  }
  for (const g of listGrants(dir)) {
    if (typeof g.grant.last_used_at !== "number" || now - g.grant.last_used_at >= GRANT_SWEEP_MS) {
      try { fs.rmSync(g.file, { force: true }); } catch { /* best-effort */ }
    }
  }
}

/**
 * Best-effort audit of a memo event through the same audit module the
 * dispatcher uses for guardrail_deny / guardrail_ask. Inert unless
 * NARAI_AUDIT_PATH is configured.
 */
export async function auditMemoEvent(eventType, details) {
  const auditPath = process.env.NARAI_AUDIT_PATH;
  if (!auditPath) return;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(__dirname, "..", "dist", "connectors", "db", "lib", "audit.js"),
    process.env.CLAUDE_PLUGIN_DATA
      ? path.join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "narai-primitives", "dist", "connectors", "db", "lib", "audit.js")
      : null,
  ].filter((p) => p !== null);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const audit = await import(pathToFileURL(p).href);
      if (audit && typeof audit.logEvent === "function") {
        audit.enableAudit(auditPath);
        audit.logEvent({ event_type: eventType, details });
      }
      return;
    } catch {
      // try next candidate
    }
  }
}

// ---------------------------------------------------------------------------
// CLI: clear / status / prune. Same self-detection pattern as dispatcher.mjs.
const isMainScript = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    const realArgv = fs.realpathSync(process.argv[1]);
    const realSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    return realArgv === realSelf;
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})();

if (isMainScript) {
  const cmd = process.argv[2];
  const dir = process.env.NARAI_MEMO_PATH;
  if (!dir) {
    process.stderr.write("memo: NARAI_MEMO_PATH not set\n");
    process.exit(2);
  }
  if (cmd === "clear") {
    const events = clearGrants(dir);
    for (const ev of events) await auditMemoEvent(ev.type, ev.details);
    process.stdout.write(`memo: cleared ${events.length} grant(s)\n`);
    process.exit(0);
  } else if (cmd === "status") {
    for (const g of listGrants(dir)) {
      process.stdout.write(JSON.stringify(g.grant) + "\n");
    }
    process.exit(0);
  } else if (cmd === "prune") {
    pruneMemoDir(dir);
    process.exit(0);
  } else {
    process.stderr.write("memo: usage — memo.mjs <clear|status|prune>\n");
    process.exit(2);
  }
}
