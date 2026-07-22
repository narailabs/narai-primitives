import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  normalizeMemoConfig,
  parsePushTarget,
  effectiveDirFor,
  resolveScope,
  // @ts-expect-error importing an untyped .mjs sibling module
} from "../../plugin-hooks/memo.mjs";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(branch = "feature-1"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-repo-"));
  execFileSync("git", ["init", "-q", dir], { encoding: "utf-8" });
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
  git(dir, "add", "f.txt");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", branch);
  return dir;
}

describe("normalizeMemoConfig", () => {
  it("accepts a full valid config", () => {
    const cfg = normalizeMemoConfig({ scope: "repo_branch", idle_minutes: 30, max_hours: 8 });
    expect(cfg).not.toBeNull();
    expect(cfg.idleMs).toBe(30 * 60 * 1000);
    expect(cfg.maxMs).toBe(8 * 60 * 60 * 1000);
  });

  it("applies defaults when idle/max are omitted", () => {
    const cfg = normalizeMemoConfig({ scope: "exact_command" });
    expect(cfg.idleMinutes).toBe(30);
    expect(cfg.maxHours).toBe(8);
  });

  it("rejects unknown scopes and bad numbers", () => {
    expect(normalizeMemoConfig({ scope: "bogus" })).toBeNull();
    expect(normalizeMemoConfig({ scope: "repo_branch", idle_minutes: 0 })).toBeNull();
    expect(normalizeMemoConfig({ scope: "repo_branch", idle_minutes: -5 })).toBeNull();
    expect(normalizeMemoConfig({ scope: "repo_branch", max_hours: "8" })).toBeNull();
    expect(normalizeMemoConfig(null)).toBeNull();
    expect(normalizeMemoConfig([])).toBeNull();
    expect(normalizeMemoConfig("repo_branch")).toBeNull();
  });
});

describe("parsePushTarget", () => {
  it("parses bare, remote-only, and remote+refspec forms", () => {
    expect(parsePushTarget("git push")).toEqual({ remote: "origin", refspec: null });
    expect(parsePushTarget("git push upstream")).toEqual({ remote: "upstream", refspec: null });
    expect(parsePushTarget("git push origin feature-1")).toEqual({
      remote: "origin",
      refspec: "feature-1",
    });
  });

  it("skips flags, including flags with separate arguments", () => {
    expect(parsePushTarget("git push -u origin feature-1")).toEqual({
      remote: "origin",
      refspec: "feature-1",
    });
    expect(parsePushTarget("git push -o ci.skip origin feature-1")).toEqual({
      remote: "origin",
      refspec: "feature-1",
    });
    expect(parsePushTarget("git push --push-option=ci.skip origin feature-1")).toEqual({
      remote: "origin",
      refspec: "feature-1",
    });
  });

  it("ignores redirections", () => {
    expect(parsePushTarget("git push 2>&1")).toEqual({ remote: "origin", refspec: null });
  });

  it("fails closed on delete/force/mapped refspecs and extra positionals", () => {
    expect(parsePushTarget("git push origin :feature-1")).toBeNull();
    expect(parsePushTarget("git push origin +feature-1")).toBeNull();
    expect(parsePushTarget("git push origin src:dst")).toBeNull();
    expect(parsePushTarget("git push origin a b")).toBeNull();
  });

  it("only matches a segment that IS a push (anchored after prefix strip)", () => {
    expect(parsePushTarget("echo git push")).toBeNull();
    expect(parsePushTarget("GIT_TRACE=1 git push")).toEqual({
      remote: "origin",
      refspec: null,
    });
  });
});

describe("effectiveDirFor", () => {
  const pushRe = /^git\s+(?:-C\s+\S+\s+)?push\b/;

  it("uses the starting cwd for a bare push", () => {
    const eff = effectiveDirFor("git push", "/start", pushRe);
    expect(eff).toEqual({ dir: "/start", segment: "git push" });
  });

  it("tracks literal cd segments across && and newlines", () => {
    expect(effectiveDirFor("cd /work/repo && git push", "/start", pushRe)?.dir).toBe(
      "/work/repo",
    );
    expect(effectiveDirFor("cd /work/repo\ngit push", "/start", pushRe)?.dir).toBe(
      "/work/repo",
    );
    expect(effectiveDirFor("cd sub && git push", "/start", pushRe)?.dir).toBe("/start/sub");
  });

  it("honors git -C", () => {
    expect(effectiveDirFor("git -C /elsewhere push", "/start", pushRe)?.dir).toBe(
      "/elsewhere",
    );
  });

  it("fails closed on non-literal cd targets", () => {
    expect(effectiveDirFor("cd $DIR && git push", "/start", pushRe)).toBeNull();
    expect(effectiveDirFor("cd $(mktemp -d) && git push", "/start", pushRe)).toBeNull();
    expect(effectiveDirFor('cd "$HOME/x" && git push', "/start", pushRe)).toBeNull();
  });

  it("returns null when no segment matches", () => {
    expect(effectiveDirFor("echo git push", "/start", pushRe)).toBeNull();
    expect(effectiveDirFor("ls -la", "/start", pushRe)).toBeNull();
  });
});

describe("resolveScope", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo("feature-1");
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("keys exact_command to the literal command", () => {
    const a = resolveScope("exact_command", "git push", "/anywhere");
    const b = resolveScope("exact_command", "git push", "/anywhere");
    const c = resolveScope("exact_command", "git push --tags", "/anywhere");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it("resolves repo_branch from the current HEAD for a bare push", () => {
    const s = resolveScope("repo_branch", "git push", repo);
    expect(s).not.toBeNull();
    expect(s.branch).toBe("feature-1");
    expect(s.remote).toBe("origin");
    expect(fs.realpathSync(s.repo)).toBe(fs.realpathSync(repo));
  });

  it("uses an explicit refspec over the current HEAD", () => {
    const s = resolveScope("repo_branch", "git push -u origin other-branch", repo);
    expect(s.branch).toBe("other-branch");
  });

  it("gives different branches different keys (independent workloads)", () => {
    const a = resolveScope("repo_branch", "git push origin b1", repo);
    const b = resolveScope("repo_branch", "git push origin b2", repo);
    expect(a.key).not.toBe(b.key);
  });

  it("fails closed outside a git repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "memo-plain-"));
    try {
      expect(resolveScope("repo_branch", "git push", plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("fails closed on a detached HEAD", () => {
    const det = makeRepo("det-branch");
    try {
      git(det, "checkout", "-q", "--detach");
      expect(resolveScope("repo_branch", "git push", det)).toBeNull();
    } finally {
      fs.rmSync(det, { recursive: true, force: true });
    }
  });

  it("fails closed for unknown scopes and non-push commands", () => {
    expect(resolveScope("bogus", "git push", repo)).toBeNull();
    expect(resolveScope("repo_branch", "echo git push", repo)).toBeNull();
  });
});
