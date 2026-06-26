/**
 * gates.test.ts — pure unit tests for plugins/gitlab-connector/gates.json.
 *
 * Replicates the dispatcher's matching logic (regex per rule, per-segment
 * compound split, strictest decision wins) so we can verify every rule
 * without spawning a subprocess. Mirrors tests/plugins/git-connector/gates.test.ts.
 *
 * These rules are conservative illustrative examples: operators customize the
 * host and verbs in their own ~/.connectors/connectors/<slug>/gates.json.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATES_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "plugins",
  "gitlab-connector",
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
      re = new RegExp(rule.pattern);
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

describe("gates.json — mr_create_without_draft (deny)", () => {
  it.each([
    "glab mr create",
    "glab mr create --title 'feat: x' --description 'y'",
    "glab mr create -t x -d y --target-branch main",
  ])("denies %s", (cmd) => {
    expect(classify(cmd)).toEqual({
      name: "mr_create_without_draft",
      decision: "deny",
    });
  });

  it.each([
    "glab mr create --draft",
    "glab mr create --title x --draft",
    "glab mr create -draft --title x",
  ])("does not match MR create with --draft: %s", (cmd) => {
    expect(classify(cmd)).toBeNull();
  });

  it("denies a curl POST to merge_requests lacking a draft indicator", () => {
    const d = classify(
      "curl -X POST https://gitlab.example.com/api/v4/projects/1/merge_requests -d 'source_branch=x'",
    );
    expect(d?.decision).toBe("deny");
    expect(d?.name).toBe("mr_create_without_draft");
  });

  it("a curl POST to merge_requests WITH draft falls back to ask, not deny", () => {
    const d = classify(
      "curl -X POST https://gitlab.example.com/api/v4/projects/1/merge_requests -d 'draft=true'",
    );
    expect(d?.decision).toBe("ask");
    expect(d?.name).toBe("gitlab_state_changing_http");
  });
});

describe("gates.json — gitlab_state_changing_http (ask)", () => {
  it.each([
    "curl -X POST https://gitlab.example.com/api/v4/projects/1/issues",
    "curl -X PUT https://gitlab.example.com/api/v4/projects/1/issues/2",
    "curl -X DELETE https://gitlab.example.com/api/v4/projects/1/issues/2",
    "curl -X PATCH https://gitlab.example.com/api/v4/projects/1/issues/2",
    "curl --request POST https://gitlab.example.com/api/v4/projects",
    "https -X DELETE https://gitlab.example.com/api/v4/projects/1",
    "wget --request PUT https://gitlab.internal/api/v4/projects/1 -O -",
  ])("asks on %s", (cmd) => {
    expect(classify(cmd)).toEqual({
      name: "gitlab_state_changing_http",
      decision: "ask",
    });
  });

  it.each([
    "curl https://gitlab.example.com/api/v4/projects/1",
    "curl -X GET https://gitlab.example.com/api/v4/projects/1",
    "curl --request GET https://gitlab.example.com/api/v4/projects",
    "curl -X POST https://example.com/webhook",
    "glab mr list",
    "glab issue list",
  ])("does not match %s", (cmd) => {
    expect(classify(cmd)).toBeNull();
  });
});

describe("gates.json — gitlab compound commands", () => {
  it("strictest decision wins (deny > ask) across segments", () => {
    const d = classify(
      "glab issue list && glab mr create --title x",
    );
    expect(d?.decision).toBe("deny");
    expect(d?.name).toBe("mr_create_without_draft");
  });
});

describe("gates.json — gitlab manifest sanity", () => {
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
