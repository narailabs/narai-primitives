import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(repoRoot, "dist", "toolkit", "cli", "usage-report.js");

let dir: string;

beforeAll(() => {
  // CI runs `vitest run --coverage` BEFORE `npm run build`, so the compiled
  // CLI may not exist yet. Build it on demand once, shared across all tests.
  if (!existsSync(cliPath)) {
    const result = spawnSync("npm", ["run", "build"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      throw new Error(
        `Integration test needs 'npm run build' to have produced ${cliPath}; ` +
          `the on-demand build failed:\n${result.stderr || result.stdout}`,
      );
    }
  }
}, 120_000);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "xs-cli-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const mk = (conn: string, sid: string, payload: Record<string, unknown>) => {
    const d = join(dir, conn, "usage");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `summary-${sid}.json`), JSON.stringify(payload));
  };
  mk("github", "S1", {
    session_id: "S1", connector: "github",
    start: "2026-04-22T10:00:00Z", end: "2026-04-22T10:15:00Z",
    total_calls: 10, total_response_bytes: 1000, total_estimated_tokens: 250,
    error_rate: 0, by_action: {}, top_responses: [],
  });
  mk("notion", "S2", {
    session_id: "S2", connector: "notion",
    start: "2026-04-22T11:00:00Z", end: "2026-04-22T11:10:00Z",
    total_calls: 5, total_response_bytes: 500, total_estimated_tokens: 125,
    error_rate: 0, by_action: {}, top_responses: [],
  });
}

function run(args: string[]) {
  return spawnSync("node", [cliPath, ...args], { encoding: "utf-8" });
}

describe("usage-report CLI", () => {
  it("prints markdown by default", () => {
    seed();
    const r = run(["--dir", dir, "--since", "all"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("# Usage report");
    expect(r.stdout).toContain("## By connector");
    expect(r.stdout).toContain("| github");
  });

  it("prints json with --format json", () => {
    seed();
    const r = run(["--dir", dir, "--since", "all", "--format", "json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.scope.sessions_scanned).toBe(2);
    expect(parsed.totals.calls).toBe(15);
    expect(parsed.by_connector.github).toBeTruthy();
  });

  it("filters by connector", () => {
    seed();
    const r = run(["--dir", dir, "--since", "all", "--connector", "github", "--format", "json"]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.scope.connector).toBe("github");
    expect(parsed.scope.sessions_scanned).toBe(1);
    expect(Object.keys(parsed.by_connector)).toEqual(["github"]);
  });

  it("errors on invalid --format", () => {
    const r = run(["--format", "xml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--format must be");
  });

  it("shows help on --help and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});
