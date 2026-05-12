/**
 * Tests for loadGithubBehavior — the connector's tiny config layer for
 * runtime knobs that aren't part of the toolkit's policy/approval YAML.
 * Precedence (highest wins):
 *   1. GITHUB_REQUIRE_DRAFT_PR env var
 *   2. <cwd>/.github-agent/config.yaml `github.require_draft_pr`
 *   3. ~/.github-agent/config.yaml  `github.require_draft_pr`
 *   4. default: false
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGithubBehavior } from "../../../../src/connectors/github/lib/github_config.js";

let tmpHome = "";
let tmpCwd = "";

function writeYaml(rootDir: string, body: string): void {
  const dir = path.join(rootDir, ".github-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), body, "utf-8");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cfg-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cfg-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("loadGithubBehavior — defaults", () => {
  it("returns requireDraftPr=false when nothing is configured", () => {
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(false);
  });
});

describe("loadGithubBehavior — YAML sources", () => {
  it("reads user-level YAML", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(true);
  });

  it("reads repo-level YAML", () => {
    writeYaml(tmpCwd, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(true);
  });

  it("repo overlay wins over user-level on collision", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    writeYaml(tmpCwd, "github:\n  require_draft_pr: false\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(false);
  });

  it("user-level wins when only user-level sets the key", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    writeYaml(tmpCwd, "policy:\n  read: success\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(true);
  });

  it("ignores files that don't have the github section", () => {
    writeYaml(tmpHome, "policy:\n  read: success\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(false);
  });

  it("rejects a non-boolean github.require_draft_pr", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: maybe\n");
    expect(() =>
      loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} }),
    ).toThrow(/require_draft_pr/);
  });
});

describe("loadGithubBehavior — env override", () => {
  it("env=1 forces true even if YAML says false", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: false\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "1" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env=true forces true", () => {
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "true" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env=yes forces true", () => {
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "yes" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env=0 forces false even if YAML says true", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "0" },
    });
    expect(b.requireDraftPr).toBe(false);
  });

  it("env=false forces false", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "false" },
    });
    expect(b.requireDraftPr).toBe(false);
  });

  it("env empty string falls through to YAML", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env with unrecognized value throws CONFIG_ERROR", () => {
    expect(() =>
      loadGithubBehavior({
        home: tmpHome,
        cwd: tmpCwd,
        env: { GITHUB_REQUIRE_DRAFT_PR: "maybe" },
      }),
    ).toThrow(/GITHUB_REQUIRE_DRAFT_PR/);
  });
});
