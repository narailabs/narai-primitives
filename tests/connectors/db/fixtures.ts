/**
 * Shared fixtures for wiki_db tests — the TypeScript port of `conftest.py`.
 *
 * Fixtures are exposed as plain helper functions (not pytest magic).
 * Tests invoke them inside beforeEach / beforeAll.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_JS = path.resolve(__dirname, "..", "..", "..", "dist", "connectors", "db", "cli.js");

/**
 * Build CLI argv for `main([...])` from the (action, params) shape the
 * connector uses on the wire. Centralises the `--action X --params '<json>'`
 * envelope so individual tests read as "run action with params" instead of
 * "serialize flags by hand".
 */
export function argsFor(
  action: "query" | "schema",
  params: Record<string, unknown>,
): string[] {
  return ["--action", action, "--params", JSON.stringify(params)];
}

/**
 * Translate the framework's 2.x envelope shape into the legacy 1.x shape
 * that pre-existing tests assert against. Lets tests keep their assertions
 * (`result.status === "ok"`, `result.rows`, `result.error`, ...) without
 * needing a wholesale rewrite.
 *
 *   Framework (2.x)                          Legacy (1.x / test-facing)
 *   --------------------------------------   --------------------------------------
 *   {status: "success", data: {...}}         {status: "ok", ...data}
 *   {status: "error", error_code, message}   {status: "error", error_code, error}
 *   {status: "denied|escalate|present_only"} (unchanged — extended envelope)
 */
export function parseResult(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const raw =
    trimmed.length === 0 ? {} : (JSON.parse(trimmed) as Record<string, unknown>);
  return unwrapEnvelope(raw);
}

export function unwrapEnvelope(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (raw["status"] === "success") {
    const data = (raw["data"] as Record<string, unknown> | undefined) ?? {};
    // Merge data fields to top-level; rewrite status to "ok".
    return { ...data, status: "ok" };
  }
  if (raw["status"] === "error") {
    // Framework uses `message`; legacy tests read `error`.
    if (raw["message"] !== undefined && raw["error"] === undefined) {
      return { ...raw, error: raw["message"] };
    }
    return raw;
  }
  // denied / escalate / present_only / other custom statuses: pass through.
  return raw;
}

/**
 * Create a fresh temp directory for a single test and return its path.
 * Analogous to pytest's built-in `tmp_path` fixture.
 */
export function makeTmpPath(prefix: string = "wiki-db-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a temp directory (best-effort). Safe to call on nonexistent paths. */
export function cleanupTmpPath(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Write a JSON credentials file at `p` with shape {db-<env>: {...}}.
 * Sets mode 0600 to satisfy the FileProvider mode check on POSIX systems.
 */
export function writeCredsFile(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data));
  if (process.platform !== "win32") {
    fs.chmodSync(p, 0o600);
  }
}

/**
 * Transient process.env mutator — sets variables and returns a restore fn.
 * Mirrors pytest's `monkeypatch.setenv` + auto-cleanup on teardown.
 */
export function patchEnv(
  vars: Record<string, string | undefined>,
): () => void {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return () => {
    for (const k of Object.keys(vars)) {
      if (prior[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prior[k];
      }
    }
  };
}

/**
 * Spawn the compiled CLI (`dist/cli.js`) out-of-process and capture stdout/stderr.
 * Requires `npm run build` to have produced `dist/cli.js`. Never throws — failure
 * exit codes are returned in the `status` field alongside captured streams.
 */
export function runCli(args: readonly string[]): {
  stdout: string;
  stderr: string;
  status: number;
} {
  try {
    const stdout = execFileSync("node", [CLI_JS, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      stdout:
        typeof err.stdout === "string"
          ? err.stdout
          : (err.stdout?.toString("utf-8") ?? ""),
      stderr:
        typeof err.stderr === "string"
          ? err.stderr
          : (err.stderr?.toString("utf-8") ?? ""),
      status: err.status ?? 1,
    };
  }
}

/**
 * Serialize a `servers` map to a plugin-shape YAML config in a fresh temp dir.
 * Returns the config file path. Caller owns cleanup via
 * `cleanupTmpPath(path.dirname(cfgPath))`.
 */
export function writeTempConfig(
  servers: Record<string, Record<string, unknown>>,
): string {
  const dir = makeTmpPath("db-agent-cfg-");
  const cfgPath = path.join(dir, "config.yaml");
  fs.writeFileSync(cfgPath, yaml.dump({ servers }));
  return cfgPath;
}
