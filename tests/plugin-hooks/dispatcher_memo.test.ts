import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin-hooks",
);
const DISPATCHER = path.join(HOOKS_DIR, "dispatcher.mjs");
const MEMO_CLI = path.join(HOOKS_DIR, "memo.mjs");

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runNode(
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd: string; stdin?: string },
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", args, {
      env: opts.env as NodeJS.ProcessEnv,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    proc.on("error", reject);
    proc.stdin.write(opts.stdin ?? "");
    proc.stdin.end();
  });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const GATES = {
  version: 1,
  name: "memo-test",
  enforcement: "fail_closed",
  rules: [
    {
      name: "push_protected",
      decision: "deny",
      reason: "blocked: protected branch",
      pattern: "git\\s+push\\b.*\\b(?:main|master)\\b",
    },
    {
      name: "force_push",
      decision: "ask",
      reason: "force push",
      pattern: "git\\s+push\\b.*(?:\\s-f\\b|--force)",
    },
    {
      name: "push",
      decision: "ask",
      reason: "push gate",
      pattern: "git\\s+push",
      memo: { scope: "repo_branch", idle_minutes: 30, max_hours: 8 },
    },
    {
      name: "mr_create",
      decision: "ask",
      reason: "mr create gate",
      pattern: "glab\\s+mr\\s+create",
    },
  ],
};

interface Fixture {
  root: string; // CLAUDE_PLUGIN_ROOT with plugin-config.json + gates.json
  repo: string; // scratch git repo on branch feature-1 (branch "other" exists)
  memoDir: string;
  auditPath: string;
  home: string;
  cleanup: string[];
}

function makeFixture(gates: unknown = GATES): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memo-root-"));
  fs.writeFileSync(
    path.join(root, "plugin-config.json"),
    JSON.stringify({ name: "memo-test" }),
  );
  fs.writeFileSync(path.join(root, "gates.json"), JSON.stringify(gates));

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "memo-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
  git(repo, "add", "f.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "branch", "other");
  git(repo, "checkout", "-q", "-b", "feature-1");
  git(repo, "remote", "add", "origin", "https://example.invalid/fixture.git");

  const memoDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-store-"));
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-audit-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memo-home-"));
  return {
    root,
    repo,
    memoDir,
    auditPath: path.join(auditDir, "audit.jsonl"),
    home,
    cleanup: [root, repo, memoDir, auditDir, home],
  };
}

function baseEnv(fx: Fixture, extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: fx.root,
    HOME: fx.home,
    NARAI_MEMO_PATH: fx.memoDir,
    NARAI_AUDIT_PATH: fx.auditPath,
  };
  // Neutralize ambient state BEFORE applying per-test overrides, so an
  // override like { NARAI_MEMO_DISABLE: "1" } survives.
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.NARAI_MEMO_DISABLE;
  delete env.NARAI_GATE_DISABLE;
  Object.assign(env, extra);
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }
  return env;
}

const SESSION = "sess-aaaa";

function bashPayload(
  fx: Fixture,
  command: string,
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: SESSION,
    cwd: fx.repo,
    permission_mode: "default",
    prompt_id: "turn-1",
    tool_name: "Bash",
    tool_input: { command },
    ...over,
  });
}

function pre(fx: Fixture, command: string, over: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return runNode([DISPATCHER, "pre-tool-use"], {
    env: baseEnv(fx, env),
    cwd: fx.repo,
    stdin: bashPayload(fx, command, over),
  });
}

function post(fx: Fixture, command: string, over: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return runNode([DISPATCHER, "post-tool-use"], {
    env: baseEnv(fx, env),
    cwd: fx.repo,
    stdin: bashPayload(fx, command, {
      tool_response: { stdout: "", stderr: "", interrupted: false },
      ...over,
    }),
  });
}

/** Approve the ask for `command`: pre (records pending) then post (confirms). */
async function approve(fx: Fixture, command: string) {
  const a = await pre(fx, command);
  expect(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  const b = await post(fx, command);
  expect(b.exitCode).toBe(0);
}

function grantFiles(fx: Fixture): string[] {
  try {
    return fs
      .readdirSync(path.join(fx.memoDir, "grants"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => path.join(fx.memoDir, "grants", n));
  } catch {
    return [];
  }
}

function pendingFiles(fx: Fixture): string[] {
  try {
    return fs
      .readdirSync(path.join(fx.memoDir, "pending"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => path.join(fx.memoDir, "pending", n));
  } catch {
    return [];
  }
}

function readGrant(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function auditEvents(fx: Fixture): Array<{ event_type: string; details: any }> {
  try {
    return fs
      .readFileSync(fx.auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("dispatcher — ask memoization", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    for (const d of fx.cleanup) fs.rmSync(d, { recursive: true, force: true });
  });

  it("zero-state: output is byte-identical with and without NARAI_MEMO_PATH", async () => {
    const commands = [
      "git push",
      "git push --force origin feature-1",
      "git push origin main",
      "glab mr create --draft",
      "ls -la",
    ];
    for (const cmd of commands) {
      const withMemo = await pre(fx, cmd);
      const without = await pre(fx, cmd, {}, { NARAI_MEMO_PATH: undefined });
      expect(withMemo.stdout).toBe(without.stdout);
      expect(withMemo.exitCode).toBe(0);
    }
  });

  it("miss records a pending entry and keeps the ask unchanged", async () => {
    const r = await pre(fx, "git push");
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("push gate");
    expect(out.systemMessage).toBeUndefined();
    expect(pendingFiles(fx)).toHaveLength(1);
    expect(grantFiles(fx)).toHaveLength(0);
  });

  it("post-tool-use promotes an approved ask into a grant (audited)", async () => {
    await approve(fx, "git push");
    const grants = grantFiles(fx);
    expect(grants).toHaveLength(1);
    const g = readGrant(grants[0]);
    expect(g.gate).toBe("push");
    expect(g.session_id).toBe(SESSION);
    expect(g.branch).toBe("feature-1");
    expect(g.remote).toBe("origin");
    expect(g.turn_at_last_use).toBe("turn-1");
    expect(typeof g.granted_at).toBe("number");
    expect(typeof g.last_used_at).toBe("number");
    expect(pendingFiles(fx)).toHaveLength(0);
    const evs = auditEvents(fx).map((e) => e.event_type);
    expect(evs).toContain("guardrail_memo_granted");
  });

  it("replays a live grant as allow with an operator announcement", async () => {
    await approve(fx, "git push");
    const r = await pre(fx, "git push");
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("memoized approval");
    expect(out.hookSpecificOutput.additionalContext).toContain("revoke memoized approvals");
    expect(out.systemMessage).toContain("auto-approved 'push'");
    const evs = auditEvents(fx).map((e) => e.event_type);
    expect(evs).toContain("guardrail_memo_replay");
  });

  it("replays across command-string variants that resolve the same scope", async () => {
    await approve(fx, "git push");
    for (const variant of [
      "git push origin feature-1",
      "git push -u origin feature-1",
      "git push 2>&1",
    ]) {
      const r = await pre(fx, variant);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision, variant).toBe("allow");
    }
  });

  it("sliding idle window: 29 min idle replays and refreshes; 31 min idle re-asks", async () => {
    await approve(fx, "git push");
    const gfile = grantFiles(fx)[0];

    const backdated29 = Date.now() - 29 * 60 * 1000;
    let g = readGrant(gfile);
    fs.writeFileSync(gfile, JSON.stringify({ ...g, last_used_at: backdated29 }));
    const r29 = await pre(fx, "git push");
    expect(JSON.parse(r29.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    // The replay refreshed last_used_at (sliding window).
    expect(readGrant(gfile).last_used_at).toBeGreaterThan(backdated29);

    g = readGrant(gfile);
    fs.writeFileSync(
      gfile,
      JSON.stringify({ ...g, last_used_at: Date.now() - 31 * 60 * 1000 }),
    );
    const r31 = await pre(fx, "git push");
    expect(JSON.parse(r31.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("8h backstop: idle-fresh but past max_hours re-asks", async () => {
    await approve(fx, "git push");
    const gfile = grantFiles(fx)[0];
    const g = readGrant(gfile);
    fs.writeFileSync(
      gfile,
      JSON.stringify({
        ...g,
        granted_at: Date.now() - (8 * 60 + 1) * 60 * 1000,
        last_used_at: Date.now() - 60 * 1000,
      }),
    );
    const r = await pre(fx, "git push");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("session isolation: another session re-asks on the same scope", async () => {
    await approve(fx, "git push");
    const r = await pre(fx, "git push", { session_id: "sess-bbbb" });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("observed branch switch drops the repo's stale-branch grants (audited)", async () => {
    await approve(fx, "git push");
    expect(grantFiles(fx)).toHaveLength(1);
    git(fx.repo, "checkout", "-q", "other");
    const r = await post(fx, "git checkout other");
    expect(r.exitCode).toBe(0);
    expect(grantFiles(fx)).toHaveLength(0);
    const inv = auditEvents(fx).filter((e) => e.event_type === "guardrail_memo_invalidated");
    expect(inv).toHaveLength(1);
    expect(inv[0].details.cause).toContain("branch switch to 'other'");
    // Returning to the branch later re-asks: the switch ended the workload.
    git(fx.repo, "checkout", "-q", "feature-1");
    const back = await pre(fx, "git push");
    expect(JSON.parse(back.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("unobserved branch switch re-asks via replay-time scope re-resolution", async () => {
    await approve(fx, "git push");
    git(fx.repo, "checkout", "-q", "other"); // no post-tool-use hook fired
    const r = await pre(fx, "git push");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    // The grant file itself is untouched — only re-resolution protects here.
    expect(grantFiles(fx)).toHaveLength(1);
  });

  it("a symbolic HEAD refspec resolves to the live branch, never the literal string", async () => {
    // "git push origin HEAD" names whatever branch is checked out, so its
    // grant must key on the resolved branch (same scope as the no-refspec
    // form) — a literal "HEAD" key would be branch-blind and survive an
    // unobserved switch.
    await approve(fx, "git push origin HEAD");
    const same = await pre(fx, "git push");
    expect(JSON.parse(same.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    git(fx.repo, "checkout", "-q", "other"); // no post-tool-use hook fired
    const r = await pre(fx, "git push origin HEAD");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("a force push never rides a plain-push grant", async () => {
    await approve(fx, "git push");
    const r = await pre(fx, "git push --force origin feature-1");
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("force push");
  });

  it("multi-ref / ref-rewriting push flags never ride a plain-push grant", async () => {
    // Even when the manifest has ONLY the memo-carrying push rule (no
    // separate force/tags rules), the engine's scope parser fails closed on
    // flags outside the scope-neutral whitelist.
    await approve(fx, "git push");
    for (const cmd of [
      "git push --tags",
      "git push --all",
      "git push --delete origin feature-1",
      "git push --force-with-lease origin feature-1",
      "git push --mirror",
    ]) {
      const r = await pre(fx, cmd);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision, cmd).toBe("ask");
    }
  });

  it("a repointed remote never rides a grant (push URL is part of the scope)", async () => {
    await approve(fx, "git push");
    const live = await pre(fx, "git push");
    expect(JSON.parse(live.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    git(fx.repo, "remote", "set-url", "origin", "https://example.invalid/elsewhere.git");
    const r = await pre(fx, "git push");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("a branch switch inside the pushing command never rides a grant", async () => {
    // `git switch other && git push` resolves HEAD before the tool runs;
    // replay-allowing it would push the post-switch branch promptless. The
    // scope fails closed on any HEAD-moving segment — and never arms a
    // grant from such a command either.
    await approve(fx, "git push");
    const r = await pre(fx, "git switch other && git push");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    const before = grantFiles(fx).length;
    await approve(fx, "git checkout other && git push");
    expect(grantFiles(fx)).toHaveLength(before); // no new grant armed
  });

  it("denies never consult the memo store", async () => {
    await approve(fx, "git push");
    const r = await pre(fx, "git push origin main");
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("a rule without a memo field keeps asking after approval (never memoized)", async () => {
    await approve(fx, "glab mr create --draft");
    expect(grantFiles(fx)).toHaveLength(0);
    const r = await pre(fx, "glab mr create --draft");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("NARAI_MEMO_DISABLE kills replay even with a live grant", async () => {
    await approve(fx, "git push");
    const withMemo = await pre(fx, "git push", {}, { NARAI_MEMO_DISABLE: "1" });
    const without = await pre(fx, "git push", {}, { NARAI_MEMO_PATH: undefined });
    expect(withMemo.stdout).toBe(without.stdout);
    expect(JSON.parse(withMemo.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("bypassPermissions execution does not create a grant", async () => {
    await pre(fx, "git push");
    const r = await post(fx, "git push", { permission_mode: "bypassPermissions" });
    expect(r.exitCode).toBe(0);
    expect(grantFiles(fx)).toHaveLength(0);
    // The pending record is consumed either way.
    expect(pendingFiles(fx)).toHaveLength(0);
  });

  it("a malformed memo config falls back to a plain ask", async () => {
    const bad = makeFixture({
      ...GATES,
      rules: GATES.rules.map((r) =>
        r.name === "push" ? { ...r, memo: { scope: "bogus" } } : r,
      ),
    });
    try {
      const a = await pre(bad, "git push");
      expect(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
      expect(a.exitCode).toBe(0);
      await post(bad, "git push");
      const b = await pre(bad, "git push");
      expect(JSON.parse(b.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
      expect(grantFiles(bad)).toHaveLength(0);
    } finally {
      for (const d of bad.cleanup) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("a non-git cwd fails closed: ask, no pending, exit 0", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "memo-plain-"));
    try {
      const r = await runNode([DISPATCHER, "pre-tool-use"], {
        env: baseEnv(fx),
        cwd: plain,
        stdin: bashPayload(fx, "git push", { cwd: plain }),
      });
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
      expect(r.exitCode).toBe(0);
      expect(pendingFiles(fx)).toHaveLength(0);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("memo.mjs clear revokes every grant (audited) and re-arms the gate", async () => {
    await approve(fx, "git push");
    expect(grantFiles(fx)).toHaveLength(1);
    const r = await runNode([MEMO_CLI, "clear"], { env: baseEnv(fx), cwd: fx.repo });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cleared 1 grant(s)");
    expect(grantFiles(fx)).toHaveLength(0);
    const inv = auditEvents(fx).filter((e) => e.event_type === "guardrail_memo_invalidated");
    expect(inv).toHaveLength(1);
    expect(inv[0].details.cause).toBe("revoked by operator");
    const again = await pre(fx, "git push");
    expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("memo.mjs status lists live grants as JSONL", async () => {
    await approve(fx, "git push");
    const r = await runNode([MEMO_CLI, "status"], { env: baseEnv(fx), cwd: fx.repo });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).gate).toBe("push");
  });
});
