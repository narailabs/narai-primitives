/**
 * Tests that the v2 lazy driver loader (`ensureDriver`) keeps optional
 * heavy deps out of the process module graph when the active config
 * doesn't reference them.
 *
 * Uses a child Node process so the module graph is guaranteed fresh — in
 * the shared vitest worker, other test files (e.g. drivers/postgresql.test.ts)
 * will have already pulled `pg` / `mongodb` / ... into require.cache.
 */
import { describe, expect, it } from "vitest";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HEAVY_DEPS = ["pg", "mysql2", "mssql", "mongodb", "@aws-sdk/client-dynamodb", "oracledb"];

describe("lazy driver loading", () => {
  it("only sqlite is loaded when the active config uses sqlite exclusively", () => {
    const projectRoot = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-agent-lazy-"));
    try {
      // V2.0: place a `.connectors/config.yaml` under the temp dir so the
      // shared connector-config loader picks it up when the child runs
      // with cwd=tmp.
      fs.mkdirSync(path.join(tmp, ".connectors"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".connectors", "config.yaml"),
        [
          "connectors:",
          "  db:",
          "    skill: db-agent-connector",
          "    policy:",
          "      read: allow",
          "      write: present",
          "      delete: present",
          "      admin: present",
          "      privilege: deny",
          "    servers:",
          "      dev:",
          "        driver: sqlite",
          "        database: \":memory:\"",
          "",
        ].join("\n"),
        "utf-8",
      );

      const cliPath = path.join(projectRoot, "dist", "cli.js");
      if (!fs.existsSync(cliPath)) {
        // Skip when dist hasn't been built (e.g. fresh checkout before
        // `npm run build`). The same guard matches what the github-agent
        // sibling tests do for their compiled-CLI suite.
        return;
      }
      const probePath = path.join(tmp, "_probe.mjs");
      // The child needs `node_modules` resolvable from its cwd; the simplest
      // way is to symlink the project's node_modules into tmp so Node's
      // module resolution finds `better-sqlite3` + `js-yaml`. Using absolute
      // paths in the probe keeps the CLI import deterministic.
      fs.symlinkSync(
        path.join(projectRoot, "node_modules"),
        path.join(tmp, "node_modules"),
      );
      fs.writeFileSync(
        probePath,
        `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { main } = await import(${JSON.stringify(cliPath)});
const code = await main(["--action", "schema", "--params", JSON.stringify({ env: "dev" })]);
const heavy = ${JSON.stringify(HEAVY_DEPS)};
const loaded = heavy.filter(dep =>
  Object.keys(require.cache).some(k =>
    k.includes("/node_modules/" + dep + "/") ||
    k.endsWith("/node_modules/" + dep)
  )
);
process.stdout.write("\\nLOADED=" + JSON.stringify(loaded) + "\\nCODE=" + code + "\\n");
`,
        "utf-8",
      );

      const result = child_process.spawnSync(process.execPath, [probePath], {
        cwd: tmp,
        encoding: "utf-8",
      });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      const loadedMatch = result.stdout.match(/LOADED=(\[.*?\])/);
      const codeMatch = result.stdout.match(/CODE=(\d+)/);
      expect(loadedMatch, `stdout: ${result.stdout}`).not.toBeNull();
      expect(codeMatch, `stdout: ${result.stdout}`).not.toBeNull();
      const loaded = JSON.parse(loadedMatch![1]!) as string[];
      const cliCode = Number(codeMatch![1]);
      expect(cliCode).toBe(0);
      expect(loaded).toEqual([]);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
