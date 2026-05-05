/**
 * Bundled-distribution smoke test.
 *
 * Asserts the post-build artifact actually has the shape every consumer
 * (the hub, doc-wiki's gather() callers, the seven plugin manifests)
 * expects. This is the gap that drove patch releases 2.1.1 (CLI not found)
 * and 2.1.2 (SKILL.md not found): unit tests passed against `src/` while
 * the bundled `dist/` layout was silently broken.
 *
 * Requires `npm run build` to have been run first. CI runs the build step
 * before tests, so this is a no-op in unconfigured local checkouts — we
 * skip rather than fail when `dist/` is absent so contributors aren't
 * forced to rebuild on every test cycle.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveAgentCli } from "../../src/toolkit/agent_resolver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const CONNECTORS = ["aws", "confluence", "db", "gcp", "github", "jira", "notion"] as const;

const distExists = fs.existsSync(path.join(repoRoot, "dist", "connectors"));

describe.skipIf(!distExists)("bundled distribution layout", () => {
  describe.each(CONNECTORS)("connector: %s", (name) => {
    const cliPath = path.join(repoRoot, "dist", "connectors", name, "cli.js");
    const skillPath = path.join(
      repoRoot,
      "plugins",
      `${name}-agent`,
      "skills",
      `${name}-agent`,
      "SKILL.md",
    );

    it("ships dist/connectors/<name>/cli.js (catches the 2.1.1 regression class)", () => {
      expect(fs.existsSync(cliPath)).toBe(true);
    });

    it("ships plugins/<name>-agent/skills/<name>-agent/SKILL.md (catches the 2.1.2 regression class)", () => {
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it("bundled CLI is a runnable Node script (spawn with no args returns a structured envelope)", () => {
      // `import()` is unsafe — most CLIs auto-run main() and call
      // process.exit at module load, which crashes the test runner.
      // spawnSync mirrors how the hub actually invokes them, so we get
      // the same surface a real call would.
      const result = spawnSync(process.execPath, [cliPath], {
        encoding: "utf8",
        timeout: 10_000,
      });
      // CLIs may exit non-zero on no-args (CONFIG_ERROR, missing-action,
      // etc.). What we're verifying is that the bundle is loadable and
      // didn't crash with a module-resolution / syntax error.
      expect(result.error).toBeUndefined();
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain("Cannot find module");
      expect(combined).not.toContain("SyntaxError");
      expect(combined).not.toContain("ERR_MODULE_NOT_FOUND");
    });

    it("resolveAgentCli locates it via bundled-self with no overrides", () => {
      // Use the real resolver against the real package root. This is the
      // exact path that broke in 2.1.1: import.meta.url-based root walk +
      // dist/connectors/<name>/cli.js lookup.
      const resolved = resolveAgentCli({ name });
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe("bundled-self");
      expect(resolved!.resolvedPath).toBe(cliPath);
    });
  });
});
