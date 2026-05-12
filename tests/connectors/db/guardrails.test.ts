/**
 * Tests for the db-connector guardrail enforced via the shared dispatcher's
 * PreToolUse handler (`plugin-hooks/dispatcher.mjs` with kind=db).
 *
 * The dispatcher is invoked as a subprocess with CLAUDE_PLUGIN_ROOT set to
 * the db-connector plugin directory — mirrors how Claude Code invokes it at
 * runtime. Tests assert the public contract: exit 0 always, stdout JSON with
 * permissionDecision: "deny" for a denied command, empty stdout for allowed.
 *
 * Note: The old per-plugin DB_AGENT_GUARDRAILS=off opt-out env var is no
 * longer supported by the dispatcher; that escape hatch was removed when
 * db-guard.mjs was absorbed.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const DISPATCHER_PATH = path.join(ROOT, "plugin-hooks", "dispatcher.mjs");
const DB_PLUGIN_ROOT = path.join(ROOT, "plugins", "db-connector");

type HookResult = { stdout: string; stderr: string; status: number | null };

function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): HookResult {
  // Sandbox HOME so any home-relative file access in the hook can't touch the
  // developer's real `~/.connectors/config.yaml` during a test run.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "db-guard-test-"));
  try {
    const result = spawnSync("node", [DISPATCHER_PATH, "pre-tool-use"], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: sandbox,
        CLAUDE_PLUGIN_ROOT: DB_PLUGIN_ROOT,
        CLAUDE_PLUGIN_DATA: sandbox,
        ...env,
      },
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function bash(command: string): unknown {
  return {
    session_id: "test",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

function isDenied(stdout: string): boolean {
  if (!stdout.trim()) return false;
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return parsed.hookSpecificOutput?.permissionDecision === "deny";
  } catch {
    return false;
  }
}

const DENY_CASES: [string, string][] = [
  ["psql", "psql -h db.example.com -U app mydb"],
  ["sqlite3", 'sqlite3 /tmp/foo.db "SELECT 1"'],
  ["mongosh", 'mongosh "mongodb://user:pw@host/db"'],
  ["aws dynamodb", "aws dynamodb list-tables --region us-east-1"],
  ["pg_dump", "pg_dump -Fc mydb > out.dump"],
  ["mysqldump", "mysqldump -u root mydb"],
  ["duckdb", "duckdb /tmp/foo.duckdb"],
  ["piped psql", "echo hello | psql -h x"],
  ["semicolon chain", "mysql -uroot -p; psql -h y"],
  ["bash -c wrapper", "bash -c 'psql -h x'"],
  ["sh -c wrapper", 'sh -c "mongosh mongodb://localhost"'],
  ["diagnostic-args no longer whitelisted", "psql --version"],
  ["help flag no longer whitelisted", "mysql --help"],
  ["absolute path basename", "/opt/homebrew/bin/psql -h db"],
  ["env prefix", "PGPASSWORD=secret psql -U u db"],
];

const ALLOW_CASES: [string, string][] = [
  ["db-connector invocation", `db-connector --action query --params '{"env":"prod","sql":"SELECT 1"}'`],
  ["db-connector absolute path", `/plugin/bin/db-connector --action schema --params '{"env":"dev"}'`],
  ["which helper", "which psql"],
  ["whereis helper", "whereis mongosh"],
  ["man page lookup", "man psql"],
  ["brew info", "brew info postgresql"],
  ["apt show", "apt show mysql-client"],
  ["listing directory", "ls /var/lib/mysql"],
  ["reading doc file", "cat psql-notes.md"],
  ["grep substring", "grep -r 'psql' ./docs"],
  ["aws non-dynamodb", "aws s3 ls"],
  ["bash -c harmless", "bash -c 'echo hello'"],
  ["empty command is ignored", "   "],
];

describe("db-guard hook", () => {
  describe("denies direct DB-client invocations", () => {
    for (const [label, cmd] of DENY_CASES) {
      it(`denies ${label}: ${cmd}`, () => {
        const r = runHook(bash(cmd));
        expect(r.status).toBe(0);
        expect(isDenied(r.stdout)).toBe(true);
        // Deny reason should cite the db-connector CLI so the model knows how to recover.
        const parsed = JSON.parse(r.stdout) as {
          hookSpecificOutput?: { permissionDecisionReason?: string };
        };
        const reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
        expect(reason).toMatch(/db-connector/);
      });
    }
  });

  describe("allows commands that don't touch a DB directly", () => {
    for (const [label, cmd] of ALLOW_CASES) {
      it(`allows ${label}: ${cmd}`, () => {
        const r = runHook(bash(cmd));
        expect(r.status).toBe(0);
        expect(isDenied(r.stdout)).toBe(false);
      });
    }
  });

  describe("scope", () => {
    it("does not fire for non-Bash tools", () => {
      const r = runHook({
        session_id: "test",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/etc/hosts" },
      });
      expect(r.status).toBe(0);
      expect(isDenied(r.stdout)).toBe(false);
    });
  });

  describe("fails open on bad input", () => {
    it("does not block when stdin is not JSON", () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "db-guard-test-"));
      try {
        const r = spawnSync("node", [DISPATCHER_PATH, "pre-tool-use"], {
          input: "this is not json at all",
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: sandbox,
            CLAUDE_PLUGIN_ROOT: DB_PLUGIN_ROOT,
            CLAUDE_PLUGIN_DATA: sandbox,
          },
        });
        expect(r.status).toBe(0);
        expect(isDenied(r.stdout ?? "")).toBe(false);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it("does not block when tool_input.command is missing", () => {
      const r = runHook({
        session_id: "test",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
      });
      expect(r.status).toBe(0);
      expect(isDenied(r.stdout)).toBe(false);
    });
  });
});
