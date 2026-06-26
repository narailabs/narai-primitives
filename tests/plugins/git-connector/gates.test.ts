/**
 * gates.test.ts — pure unit tests for plugins/git-connector/gates.json.
 *
 * Replicates the dispatcher's matching logic (regex per rule, per-segment
 * compound split, strictest decision wins) so we can verify every rule
 * without spawning a subprocess. Complements the end-to-end smoke tests
 * in `smoke.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expandPattern } from "../../../plugin-hooks/dispatcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATES_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "plugins",
  "git-connector",
  "gates.json",
);

interface Rule {
  name: string;
  decision: "deny" | "ask" | "allow";
  reason: string;
  pattern: string;
}

const manifest = JSON.parse(fs.readFileSync(GATES_PATH, "utf-8")) as {
  rules: Rule[];
};

const RANK: Record<string, number> = { deny: 2, ask: 1, allow: 0 };

function splitCompound(cmd: string): string[] {
  if (typeof cmd !== "string") return [];
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts
    .map((p) => stripPrefix(p.trim()))
    .filter((p) => p.length > 0);
}

function stripPrefix(s: string): string {
  let cur = s;
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cur)) {
    cur = cur.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return cur.replace(/^(sudo|nice|time)\s+/, "");
}

function classify(
  command: string,
  disabled = new Set<string>(),
): { name: string; decision: string } | null {
  const matches: { name: string; decision: string }[] = [];
  for (const rule of manifest.rules) {
    if (disabled.has(rule.name)) continue;
    let re: RegExp;
    try {
      re = new RegExp(expandPattern(rule.pattern));
    } catch {
      continue;
    }
    for (const segment of splitCompound(command)) {
      if (re.test(segment)) {
        matches.push({ name: rule.name, decision: rule.decision });
        break;
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => RANK[b.decision] - RANK[a.decision]);
  return matches[0];
}

describe("gates.json — push_main (deny)", () => {
  it.each([
    "git push origin main",
    "git push origin master",
    "git push origin HEAD:main",
    "git push origin HEAD:master",
    "git push origin :main",
    "git push --force origin main",
    "git push -f origin master",
  ])("denies %s", (cmd) => {
    expect(classify(cmd)).toEqual({ name: "push_main", decision: "deny" });
  });

  it("does not deny push to a feature branch", () => {
    expect(classify("git push origin my-feature")).toEqual({
      name: "push",
      decision: "ask",
    });
  });

  it("does not deny when target name contains main as substring", () => {
    expect(classify("git push origin maintenance")?.name).toBe("push");
  });
});

describe("gates.json — force_push (deny) vs force-with-lease (ask)", () => {
  it.each([
    "git push --force",
    "git push -f origin feature",
    "git push --force origin feature",
  ])("denies bare force %s", (cmd) => {
    expect(classify(cmd)).toEqual({ name: "force_push", decision: "deny" });
  });

  it.each([
    "git push --force-with-lease",
    "git push --force-with-lease origin feature",
  ])("asks on lease-guarded force %s", (cmd) => {
    expect(classify(cmd)).toEqual({ name: "force_with_lease", decision: "ask" });
  });

  it("force-push to a protected branch still denies", () => {
    expect(classify("git push --force origin main")?.decision).toBe("deny");
  });
});

describe("gates.json — mirror_push (deny)", () => {
  it.each([
    "git push --mirror",
    "git push --mirror origin",
  ])("denies %s", (cmd) => {
    expect(classify(cmd)).toEqual({ name: "mirror_push", decision: "deny" });
  });
});

describe("gates.json — configurable protected branches", () => {
  const orig = process.env.NARAI_GIT_PROTECTED_BRANCHES;
  afterEach(() => {
    if (orig === undefined) delete process.env.NARAI_GIT_PROTECTED_BRANCHES;
    else process.env.NARAI_GIT_PROTECTED_BRANCHES = orig;
  });

  it("denies main/master by default", () => {
    delete process.env.NARAI_GIT_PROTECTED_BRANCHES;
    expect(classify("git push origin main")?.name).toBe("push_main");
    expect(classify("git push origin master")?.name).toBe("push_main");
  });

  it("denies an operator-configured protected branch", () => {
    process.env.NARAI_GIT_PROTECTED_BRANCHES = "release,prod";
    expect(classify("git push origin release")?.name).toBe("push_main");
    expect(classify("git push origin prod")?.name).toBe("push_main");
  });

  it("does not deny an unprotected branch even with extras configured", () => {
    process.env.NARAI_GIT_PROTECTED_BRANCHES = "release";
    expect(classify("git push origin my-feature")?.name).toBe("push");
  });
});

describe("gates.json — enforcement posture", () => {
  it("declares fail_closed", () => {
    expect(manifest.enforcement).toBe("fail_closed");
  });
});

describe("gates.json — delete_branch_remote (ask)", () => {
  it.each([
    "git push --delete origin feature",
    "git push -d origin feature",
    "git push origin :feature",
  ])("asks on %s", (cmd) => {
    const d = classify(cmd);
    expect(d?.decision).toBe("ask");
    expect(["delete_branch_remote", "push"]).toContain(d?.name);
  });

  it("does not classify a normal push as delete_branch_remote", () => {
    expect(classify("git push origin feature")?.name).toBe("push");
  });
});

describe("gates.json — push (ask, plain)", () => {
  it("asks on plain push", () => {
    expect(classify("git push")).toEqual({ name: "push", decision: "ask" });
  });

  it("asks on push origin <branch>", () => {
    expect(classify("git push origin feature")).toEqual({
      name: "push",
      decision: "ask",
    });
  });

  it("asks on push --tags", () => {
    expect(classify("git push --tags")).toEqual({
      name: "push",
      decision: "ask",
    });
  });
});

describe("gates.json — delete_branch_local (ask)", () => {
  it.each([
    "git branch -D feature",
    "git branch --delete --force feature",
    "git branch -Df feature",
  ])("asks on %s", (cmd) => {
    expect(classify(cmd)).toEqual({
      name: "delete_branch_local",
      decision: "ask",
    });
  });

  it("does not fire on git branch -d (lowercase, non-force)", () => {
    expect(classify("git branch -d feature")).toBeNull();
  });
});

describe("gates.json — reset_hard (ask)", () => {
  it("asks on git reset --hard", () => {
    expect(classify("git reset --hard")).toEqual({
      name: "reset_hard",
      decision: "ask",
    });
  });

  it("asks on git reset --hard HEAD~1", () => {
    expect(classify("git reset --hard HEAD~1")).toEqual({
      name: "reset_hard",
      decision: "ask",
    });
  });

  it("does not fire on git reset (no --hard)", () => {
    expect(classify("git reset HEAD~1")).toBeNull();
  });

  it("does not fire on git reset --soft", () => {
    expect(classify("git reset --soft HEAD~1")).toBeNull();
  });
});

describe("gates.json — checkout_discard (ask)", () => {
  it.each([
    "git checkout .",
    "git checkout -- src/foo.ts",
    "git checkout main -- src/foo.ts",
    "git restore --worktree src/foo.ts",
    "git restore -W src/foo.ts",
    "git restore .",
  ])("asks on %s", (cmd) => {
    expect(classify(cmd)?.name).toBe("checkout_discard");
  });

  it("does not fire on plain branch switch", () => {
    expect(classify("git checkout main")).toBeNull();
    expect(classify("git checkout -b feature")).toBeNull();
  });

  it("does not fire on git restore --staged (index-only)", () => {
    expect(classify("git restore --staged src/foo.ts")).toBeNull();
  });
});

describe("gates.json — clean_force (ask)", () => {
  it.each([
    "git clean -f",
    "git clean -fd",
    "git clean -fdx",
    "git clean -df",
    "git clean -xdf",
  ])("asks on %s", (cmd) => {
    expect(classify(cmd)).toEqual({ name: "clean_force", decision: "ask" });
  });

  it("does not fire on git clean -n (dry run)", () => {
    expect(classify("git clean -n")).toBeNull();
  });
});

describe("gates.json — compound commands", () => {
  it("strictest decision wins (deny > ask)", () => {
    const d = classify("git push origin feature && git push origin main");
    expect(d?.decision).toBe("deny");
    expect(d?.name).toBe("push_main");
  });

  it("env prefix on a chained git command still classifies", () => {
    expect(
      classify("cd repo && FOO=bar git push --force")?.name,
    ).toBe("force_push");
  });

  it("non-git compound returns null", () => {
    expect(classify("ls && cat foo.txt")).toBeNull();
  });
});

describe("gates.json — disabled rules", () => {
  it("disabled rule is skipped", () => {
    expect(classify("git push", new Set(["push"]))).toBeNull();
  });

  it("disabling push_main lets the request fall through to push (ask)", () => {
    expect(classify("git push origin main", new Set(["push_main"]))).toEqual({
      name: "push",
      decision: "ask",
    });
  });

  it("disabling all relevant rules allows push silently", () => {
    expect(
      classify("git push origin main", new Set(["push_main", "push"])),
    ).toBeNull();
  });
});

describe("gates.json — safe non-git commands", () => {
  it.each([
    "ls -la",
    "npm install",
    "git status",
    "git log",
    "git diff",
    "git fetch origin",
    "git pull",
    "git commit -m 'msg'",
    "git add .",
    "git checkout main",
  ])("%s does not match any rule", (cmd) => {
    expect(classify(cmd)).toBeNull();
  });
});

describe("gates.json — manifest sanity", () => {
  it("every rule has required fields with valid shape", () => {
    for (const r of manifest.rules) {
      expect(typeof r.name).toBe("string");
      expect(["deny", "ask", "allow"]).toContain(r.decision);
      expect(typeof r.reason).toBe("string");
      expect(typeof r.pattern).toBe("string");
      expect(() => new RegExp(r.pattern)).not.toThrow();
    }
  });

  it("rule names are unique", () => {
    const names = manifest.rules.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
