import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugins",
  "create-connector",
  "skills",
  "create-connector",
  "assets",
  "templates",
);

describe("flavor templates", () => {
  it("shell-gate has gates.json.tmpl and SKILL.md.tmpl", () => {
    expect(fs.existsSync(path.join(TEMPLATES, "shell-gate", "gates.json.tmpl"))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATES, "shell-gate", "SKILL.md.tmpl"))).toBe(true);
  });

  it("shell-gate gates.json.tmpl has {{RULES}} placeholder", () => {
    const tmpl = fs.readFileSync(
      path.join(TEMPLATES, "shell-gate", "gates.json.tmpl"),
      "utf-8",
    );
    expect(tmpl).toContain("{{RULES}}");
  });

  it("shell-gate SKILL.md.tmpl has slug and rules-table placeholders", () => {
    const tmpl = fs.readFileSync(
      path.join(TEMPLATES, "shell-gate", "SKILL.md.tmpl"),
      "utf-8",
    );
    expect(tmpl).toContain("{{SLUG}}");
    expect(tmpl).toContain("{{RULES_TABLE}}");
  });

  it("composite has all three template files", () => {
    expect(fs.existsSync(path.join(TEMPLATES, "composite", "index.mjs.tmpl"))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATES, "composite", "bin.tmpl"))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATES, "composite", "SKILL.md.tmpl"))).toBe(true);
  });

  it("knowledge template references runbook usage", () => {
    const tmpl = fs.readFileSync(
      path.join(TEMPLATES, "knowledge", "SKILL.md.tmpl"),
      "utf-8",
    );
    expect(tmpl).toContain("Knowledge-only");
    expect(tmpl).toContain("{{STEPS}}");
  });
});
