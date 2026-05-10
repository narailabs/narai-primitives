import { describe, it, expect } from "vitest";
import {
  decide,
  splitCompound,
  DEFAULT_RULES,
} from "../../../plugins/git-plugin/hooks/rules.mjs";

function decision(cmd, opts) {
  const r = decide(cmd, opts);
  return r === null ? null : { name: r.name, decision: r.decision };
}

describe("splitCompound", () => {
  it("returns single command unchanged", () => {
    expect(splitCompound("git push")).toEqual(["git push"]);
  });

  it("splits on &&", () => {
    expect(splitCompound("cd repo && git push")).toEqual([
      "cd repo",
      "git push",
    ]);
  });

  it("splits on ||, ;, |", () => {
    expect(splitCompound("a || b ; c | d")).toEqual(["a", "b", "c", "d"]);
  });

  it("strips leading env-var prefixes", () => {
    expect(splitCompound("FOO=bar BAZ=qux git push")).toEqual(["git push"]);
  });

  it("strips leading sudo / nice / time", () => {
    expect(splitCompound("sudo git push")).toEqual(["git push"]);
    expect(splitCompound("nice git status")).toEqual(["git status"]);
    expect(splitCompound("time git pull")).toEqual(["git pull"]);
  });

  it("ignores empty input", () => {
    expect(splitCompound("")).toEqual([]);
    expect(splitCompound(null)).toEqual([]);
    expect(splitCompound(undefined)).toEqual([]);
  });
});

describe("default rules — push_main (deny)", () => {
  it.each([
    "git push origin main",
    "git push origin master",
    "git push origin HEAD:main",
    "git push origin HEAD:master",
    "git push origin :main",
    "git push --force origin main",
    "git push -f origin master",
  ])("denies %s", (cmd) => {
    expect(decision(cmd)).toEqual({ name: "push_main", decision: "deny" });
  });

  it("does not fire on push to a feature branch", () => {
    expect(decision("git push origin my-feature")).toEqual({
      name: "push",
      decision: "ask",
    });
  });

  it("does not deny when target is unrelated despite branch name containing main", () => {
    // 'maintenance' should not match \bmain\b
    expect(decision("git push origin maintenance")?.name).toBe("push");
  });
});

describe("default rules — force_push (ask)", () => {
  it.each([
    "git push --force",
    "git push --force origin main",
    "git push -f origin feature",
    "git push --force-with-lease",
    "git push --force-with-lease origin feature",
  ])("asks on %s", (cmd) => {
    const d = decide(cmd);
    expect(d).not.toBeNull();
    // push to main/master + force still wins via deny.
    if (cmd.includes("main") || cmd.includes("master")) {
      expect(d.name).toBe("push_main");
    } else {
      expect(d.name).toBe("force_push");
      expect(d.decision).toBe("ask");
    }
  });
});

describe("default rules — delete_branch_remote (ask)", () => {
  it.each([
    "git push --delete origin feature",
    "git push -d origin feature",
    "git push origin :feature",
  ])("asks on %s", (cmd) => {
    const d = decide(cmd);
    expect(d?.decision).toBe("ask");
    expect(["delete_branch_remote", "push_main"]).toContain(d?.name);
  });

  it("does not classify a normal push as delete_branch_remote", () => {
    expect(decide("git push origin feature")?.name).toBe("push");
  });
});

describe("default rules — push (ask, plain)", () => {
  it("asks on plain push", () => {
    expect(decision("git push")).toEqual({ name: "push", decision: "ask" });
  });

  it("asks on push origin <branch>", () => {
    expect(decision("git push origin feature")).toEqual({
      name: "push",
      decision: "ask",
    });
  });

  it("asks on push --tags", () => {
    expect(decision("git push --tags")).toEqual({
      name: "push",
      decision: "ask",
    });
  });
});

describe("default rules — delete_branch_local (ask)", () => {
  it.each([
    "git branch -D feature",
    "git branch --delete --force feature",
    "git branch -Df feature",
  ])("asks on %s", (cmd) => {
    expect(decision(cmd)).toEqual({
      name: "delete_branch_local",
      decision: "ask",
    });
  });

  it("does not fire on git branch -d (lowercase, non-force)", () => {
    expect(decide("git branch -d feature")).toBeNull();
  });
});

describe("default rules — reset_hard (ask)", () => {
  it("asks on git reset --hard", () => {
    expect(decision("git reset --hard")).toEqual({
      name: "reset_hard",
      decision: "ask",
    });
  });

  it("asks on git reset --hard HEAD~1", () => {
    expect(decision("git reset --hard HEAD~1")).toEqual({
      name: "reset_hard",
      decision: "ask",
    });
  });

  it("does not fire on git reset (no --hard)", () => {
    expect(decide("git reset HEAD~1")).toBeNull();
  });

  it("does not fire on git reset --soft", () => {
    expect(decide("git reset --soft HEAD~1")).toBeNull();
  });
});

describe("default rules — checkout_discard (ask)", () => {
  it.each([
    "git checkout .",
    "git checkout -- src/foo.ts",
    "git checkout main -- src/foo.ts",
    "git restore --worktree src/foo.ts",
    "git restore -W src/foo.ts",
    "git restore .",
  ])("asks on %s", (cmd) => {
    expect(decision(cmd)?.name).toBe("checkout_discard");
  });

  it("does not fire on plain branch switch", () => {
    expect(decide("git checkout main")).toBeNull();
    expect(decide("git checkout -b feature")).toBeNull();
  });

  it("does not fire on git restore --staged (index-only)", () => {
    expect(decide("git restore --staged src/foo.ts")).toBeNull();
  });
});

describe("default rules — clean_force (ask)", () => {
  it.each([
    "git clean -f",
    "git clean -fd",
    "git clean -fdx",
    "git clean -df",
    "git clean -xdf",
  ])("asks on %s", (cmd) => {
    expect(decision(cmd)).toEqual({ name: "clean_force", decision: "ask" });
  });

  it("does not fire on git clean -n (dry run)", () => {
    expect(decide("git clean -n")).toBeNull();
  });
});

describe("compound commands", () => {
  it("strictest decision wins (deny > ask)", () => {
    const d = decide("git push origin feature && git push origin main");
    expect(d?.decision).toBe("deny");
    expect(d?.name).toBe("push_main");
  });

  it("first segment matches if later segments are non-git", () => {
    expect(decide("git push && echo done")).toEqual(
      expect.objectContaining({ name: "push", decision: "ask" }),
    );
  });

  it("non-git compound returns null", () => {
    expect(decide("ls && cat foo.txt")).toBeNull();
  });

  it("env prefix on a chained git command still classifies", () => {
    expect(decide("cd repo && FOO=bar git push --force")?.name).toBe(
      "force_push",
    );
  });
});

describe("disabled rules", () => {
  it("disabled rule is skipped", () => {
    expect(
      decide("git push", { disabled: new Set(["push"]) }),
    ).toBeNull();
  });

  it("disabling push_main allows push to main (still asks)", () => {
    const d = decide("git push origin main", {
      disabled: new Set(["push_main"]),
    });
    expect(d?.name).toBe("push");
    expect(d?.decision).toBe("ask");
  });

  it("disabling all relevant rules allows push silently", () => {
    expect(
      decide("git push origin main", {
        disabled: new Set(["push_main", "push"]),
      }),
    ).toBeNull();
  });
});

describe("extra rules from config", () => {
  const releaseRule = {
    name: "deny_release",
    decision: "deny",
    reason: "release branch denied",
    match: (s) => /^git\s+push\s+\S+\s+release\b/.test(s),
  };

  it("custom rule fires on matching command", () => {
    expect(
      decide("git push origin release/v1", { extraRules: [releaseRule] }),
    ).toEqual(
      expect.objectContaining({ name: "deny_release", decision: "deny" }),
    );
  });

  it("custom deny beats default ask", () => {
    // 'git push' alone would ask via 'push' rule; custom deny on release wins.
    const d = decide("git push origin release/v1", {
      extraRules: [releaseRule],
    });
    expect(d?.decision).toBe("deny");
  });
});

describe("non-git commands return null", () => {
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
    expect(decide(cmd)).toBeNull();
  });
});

describe("default rule set sanity", () => {
  it("every rule has the required fields", () => {
    for (const r of DEFAULT_RULES) {
      expect(typeof r.name).toBe("string");
      expect(["deny", "ask", "allow"]).toContain(r.decision);
      expect(typeof r.reason).toBe("string");
      expect(typeof r.match).toBe("function");
    }
  });

  it("rule names are unique", () => {
    const names = DEFAULT_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
