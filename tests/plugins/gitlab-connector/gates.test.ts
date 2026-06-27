/**
 * gates.test.ts — tests for plugins/gitlab-connector/gates.json.
 *
 * Drives the real exported applyGatesManifest engine against the shipped
 * manifest: the mr_create_without_draft pattern rule and the declarative
 * gitlab_external_write host-allowlist rule. These rules are conservative
 * illustrative examples: operators set their GitLab host in
 * ~/.connectors/connectors/gitlab/gates.json.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applyGatesManifest } from "../../../plugin-hooks/dispatcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATES_PATH = path.resolve(
  __dirname, "..", "..", "..", "plugins", "gitlab-connector", "gates.json",
);
const manifest = JSON.parse(fs.readFileSync(GATES_PATH, "utf-8"));

function decide(command: string): string | null {
  const decisions: { decision: string; reason: string }[] = [];
  applyGatesManifest(manifest, "gitlab", command, new Set<string>(), decisions, "Bash");
  if (decisions.length === 0) return null;
  const rank: Record<string, number> = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision]! - rank[a.decision]!);
  return decisions[0]!.decision;
}

describe("gitlab gates — mr_create_without_draft (deny)", () => {
  it.each([
    "glab mr create --title x",
    "glab mr create",
  ])("denies %s", (cmd) => {
    expect(decide(cmd)).toBe("deny");
  });

  it.each([
    "glab mr create --draft --title x",
    "glab mr create -draft",
    "glab mr list",
  ])("allows %s", (cmd) => {
    expect(decide(cmd)).toBeNull();
  });

  it("denies a curl MR-create POST lacking a draft marker", () => {
    expect(
      decide("curl -X POST https://gitlab.com/api/v4/projects/1/merge_requests -d title=x"),
    ).toBe("deny");
  });
});

describe("gitlab gates — external_write (ask on writes to gitlab.com)", () => {
  it.each([
    "curl -X POST https://gitlab.com/api/v4/projects/1/issues",
    "curl --request DELETE https://gitlab.com/api/v4/projects/1/issues/2",
    "curl -X PUT https://gitlab.com/api/v4/x",
    "https POST gitlab.com/api/v4/x", // HTTPie positional
  ])("asks on %s", (cmd) => {
    expect(decide(cmd)).toBe("ask");
  });

  it.each([
    "curl https://gitlab.com/api/v4/projects/1/issues", // GET
    "glab issue list",
  ])("allows %s", (cmd) => {
    expect(decide(cmd)).toBeNull();
  });

  // Anchored host: bare `gitlab` substring previously over-matched these.
  it.each([
    "curl -X POST https://gitlab.evil.com/api/v4/x", // attacker subdomain
    "curl -X POST https://evil.com/gitlab-mirror", // path token
    "curl -X POST https://gitlab-runner.evil.com/h", // label-prefix on attacker host
    "curl -X POST https://my-gitlab.evil.com/h", // prefix on attacker host
    "curl -X POST https://gitlab.example.com/api/v4/x", // self-hosted host not in default allowlist
  ])("does not over-match %s", (cmd) => {
    expect(decide(cmd)).toBeNull();
  });
});

describe("gitlab manifest sanity", () => {
  it("every rule is a valid external_write or pattern rule", () => {
    for (const r of manifest.rules) {
      expect(typeof r.name).toBe("string");
      expect(["deny", "ask", "allow"]).toContain(r.decision);
      expect(typeof r.reason).toBe("string");
      if (r.type === "external_write") {
        expect(Array.isArray(r.methods) && r.methods.length > 0).toBe(true);
        expect(Array.isArray(r.allowed_hosts)).toBe(true);
      } else {
        expect(typeof r.pattern).toBe("string");
        expect(() => new RegExp(r.pattern)).not.toThrow();
      }
    }
  });

  it("rule names are unique", () => {
    const names = manifest.rules.map((r: { name: string }) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
