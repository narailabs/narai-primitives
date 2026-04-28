import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { renderSkillPreamble } from "../../src/toolkit/hardship/preamble.js";

describe("renderSkillPreamble", () => {
  it("returns empty when no patterns.yaml exists", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "preamble-"));
    const out = renderSkillPreamble({
      connector: "jira",
      scope: "acme.atlassian.net",
      cwd: tmp,
      home: tmp,
    });
    expect(out).toBe("");
    await fsp.rm(tmp, { recursive: true });
  });

  it("renders active patterns as bullet list (drafts excluded)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "preamble-"));
    const hash = (await import("../../src/toolkit/hardship/scope.js")).hashScopeKey("acme");
    const scopedDir = path.join(
      tmp,
      ".claude/connectors/jira/tenants",
      hash,
    );
    await fsp.mkdir(scopedDir, { recursive: true });
    await fsp.writeFile(
      path.join(scopedDir, "patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: jira-archived-404
    status: active
    confidence: 0.95
    kind: not_found
    matcher: { context_regex: "archived" }
    advice: "Check fields.archivedBy before retry."
  - pattern_id: draft-pattern
    status: draft
    confidence: 0.5
    kind: timeout
    matcher: {}
    advice: "noise"
`,
    );

    const out = renderSkillPreamble({
      connector: "jira",
      scope: "acme",
      cwd: tmp,
      home: tmp,
    });
    expect(out).toContain("## Known gotchas");
    expect(out).toContain("jira-archived-404");
    expect(out).toContain("Check fields.archivedBy");
    expect(out).not.toContain("draft-pattern");

    await fsp.rm(tmp, { recursive: true });
  });

  it("dedupes across tiers preferring most-specific", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "preamble-dedup-"));
    const tenantDir = path.join(
      tmp,
      ".claude/connectors/jira/tenants",
      (await import("../../src/toolkit/hardship/scope.js")).hashScopeKey("acme"),
    );
    const globalDir = path.join(tmp, ".claude/connectors/jira/global");
    await fsp.mkdir(tenantDir, { recursive: true });
    await fsp.mkdir(globalDir, { recursive: true });

    // Same pattern_id in both tiers, different advice text
    await fsp.writeFile(
      path.join(tenantDir, "patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: shared-id
    status: active
    confidence: 1.0
    kind: timeout
    matcher: {}
    advice: "tenant-specific advice"
`,
    );
    await fsp.writeFile(
      path.join(globalDir, "patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: shared-id
    status: active
    confidence: 1.0
    kind: timeout
    matcher: {}
    advice: "generic advice"
`,
    );

    const out = renderSkillPreamble({
      connector: "jira",
      scope: "acme",
      cwd: tmp,
      home: tmp,
    });
    expect(out).toContain("tenant-specific advice");
    expect(out).not.toContain("generic advice");

    await fsp.rm(tmp, { recursive: true });
  });
});
