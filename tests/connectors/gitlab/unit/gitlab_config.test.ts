/**
 * Tests for loadGitlabBehavior — the connector's tiny config layer for
 * runtime knobs that aren't part of the toolkit's policy/approval YAML.
 * Precedence (highest wins):
 *   1. GITLAB_REQUIRE_DRAFT_MR / GITLAB_HOST env vars
 *   2. <cwd>/.gitlab-connector/config.yaml `gitlab.*`
 *   3. ~/.gitlab-connector/config.yaml  `gitlab.*`
 *   4. defaults: requireDraftMr=false, host="https://gitlab.com"
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGitlabBehavior } from "../../../../src/connectors/gitlab/lib/gitlab_config.js";

let tmpHome = "";
let tmpCwd = "";

function writeYaml(rootDir: string, body: string): void {
  const dir = path.join(rootDir, ".gitlab-connector");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), body, "utf-8");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gl-cfg-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gl-cfg-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("loadGitlabBehavior — defaults", () => {
  it("returns requireDraftMr=false and host=https://gitlab.com when nothing is configured", () => {
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftMr).toBe(false);
    expect(b.host).toBe("https://gitlab.com");
  });
});

describe("loadGitlabBehavior — YAML sources (requireDraftMr)", () => {
  it("reads user-level YAML require_draft_mr", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: true\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftMr).toBe(true);
  });

  it("reads repo-level YAML require_draft_mr", () => {
    writeYaml(tmpCwd, "gitlab:\n  require_draft_mr: true\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftMr).toBe(true);
  });

  it("repo overlay wins over user-level on collision", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: true\n");
    writeYaml(tmpCwd, "gitlab:\n  require_draft_mr: false\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftMr).toBe(false);
  });

  it("user-level wins when only user-level sets the key", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: true\n");
    writeYaml(tmpCwd, "policy:\n  read: success\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftMr).toBe(true);
  });

  it("ignores files that don't have the gitlab section", () => {
    writeYaml(tmpHome, "policy:\n  read: success\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftMr).toBe(false);
  });

  it("rejects a non-boolean gitlab.require_draft_mr", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: maybe\n");
    expect(() =>
      loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} }),
    ).toThrow(/require_draft_mr/);
  });
});

describe("loadGitlabBehavior — env override (requireDraftMr)", () => {
  it("env=1 forces true even if YAML says false", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: false\n");
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_REQUIRE_DRAFT_MR: "1" },
    });
    expect(b.requireDraftMr).toBe(true);
  });

  it("env=true forces true", () => {
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_REQUIRE_DRAFT_MR: "true" },
    });
    expect(b.requireDraftMr).toBe(true);
  });

  it("env=yes forces true", () => {
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_REQUIRE_DRAFT_MR: "yes" },
    });
    expect(b.requireDraftMr).toBe(true);
  });

  it("env=0 forces false even if YAML says true", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: true\n");
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_REQUIRE_DRAFT_MR: "0" },
    });
    expect(b.requireDraftMr).toBe(false);
  });

  it("env=false forces false", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: true\n");
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_REQUIRE_DRAFT_MR: "false" },
    });
    expect(b.requireDraftMr).toBe(false);
  });

  it("env empty string falls through to YAML", () => {
    writeYaml(tmpHome, "gitlab:\n  require_draft_mr: true\n");
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_REQUIRE_DRAFT_MR: "" },
    });
    expect(b.requireDraftMr).toBe(true);
  });

  it("env with unrecognized value throws CONFIG_ERROR", () => {
    expect(() =>
      loadGitlabBehavior({
        home: tmpHome,
        cwd: tmpCwd,
        env: { GITLAB_REQUIRE_DRAFT_MR: "maybe" },
      }),
    ).toThrow(/GITLAB_REQUIRE_DRAFT_MR/);
  });
});

describe("loadGitlabBehavior — host knob", () => {
  it("returns default host when nothing is configured", () => {
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.host).toBe("https://gitlab.com");
  });

  it("reads user-level YAML gitlab.host", () => {
    writeYaml(tmpHome, "gitlab:\n  host: https://gitlab.mycorp\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.host).toBe("https://gitlab.mycorp");
  });

  it("repo-level YAML host overrides user-level", () => {
    writeYaml(tmpHome, "gitlab:\n  host: https://gitlab.mycorp\n");
    writeYaml(tmpCwd, "gitlab:\n  host: https://gitlab.internal\n");
    const b = loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.host).toBe("https://gitlab.internal");
  });

  it("env GITLAB_HOST overrides YAML", () => {
    writeYaml(tmpHome, "gitlab:\n  host: https://gitlab.mycorp\n");
    const b = loadGitlabBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITLAB_HOST: "https://gitlab.override" },
    });
    expect(b.host).toBe("https://gitlab.override");
  });

  it("rejects non-string gitlab.host", () => {
    writeYaml(tmpHome, "gitlab:\n  host: 12345\n");
    expect(() =>
      loadGitlabBehavior({ home: tmpHome, cwd: tmpCwd, env: {} }),
    ).toThrow(/host/);
  });
});
