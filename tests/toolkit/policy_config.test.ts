import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deepMerge,
  loadPolicyConfig,
  validatePolicyConfig,
} from "../../src/toolkit/policy/config.js";

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "policy-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "policy-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function writeHomeConfig(name: string, yaml: string) {
  const dir = path.join(tmpHome, `.${name}-agent`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

function writeRepoConfig(name: string, yaml: string) {
  const dir = path.join(tmpCwd, `.${name}-agent`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("validatePolicyConfig — safety floor", () => {
  it("admin=success is rejected", () => {
    expect(() =>
      validatePolicyConfig({ policy: { admin: "success" } }),
    ).toThrow(/safety floor/);
  });

  it("floorAspects set to success is rejected", () => {
    expect(() =>
      validatePolicyConfig(
        { policy: { aspects: { ddl: "success" } } },
        ["ddl"],
      ),
    ).toThrow(/safety floor/);
  });

  it("admin=denied is allowed", () => {
    const out = validatePolicyConfig({ policy: { admin: "denied" } });
    expect(out.rules.admin).toBe("denied");
  });

  it("non-floor aspect can be set to success", () => {
    const out = validatePolicyConfig(
      { policy: { aspects: { source_code: "success" } } },
      [],
    );
    expect(out.rules.aspects?.["source_code"]).toBe("success");
  });
});

describe("validatePolicyConfig — invalid input", () => {
  it("unknown policy key rejected", () => {
    expect(() =>
      validatePolicyConfig({ policy: { unknown: "success" } }),
    ).toThrow(/unknown key/);
  });

  it("invalid rule value rejected", () => {
    expect(() =>
      validatePolicyConfig({ policy: { read: "maybe" } }),
    ).toThrow(/expected one of/);
  });

  it("invalid approval_mode rejected", () => {
    expect(() =>
      validatePolicyConfig({ approval_mode: "maybe" }),
    ).toThrow(/expected one of/);
  });

  it("root must be a mapping", () => {
    expect(() => validatePolicyConfig("string")).toThrow(/YAML mapping/);
  });
});

describe("deepMerge", () => {
  it("overlay wins on scalar collision", () => {
    const out = deepMerge({ a: 1, b: 2 }, { b: 99 });
    expect(out).toEqual({ a: 1, b: 99 });
  });

  it("recursive merge on nested objects", () => {
    const out = deepMerge(
      { policy: { read: "success", write: "present" } },
      { policy: { write: "denied" } },
    );
    expect(out).toEqual({ policy: { read: "success", write: "denied" } });
  });

  it("arrays replace (no element-wise merge)", () => {
    const out = deepMerge({ x: [1, 2, 3] }, { x: [9] });
    expect(out.x).toEqual([9]);
  });
});

describe("loadPolicyConfig — discovery + merge", () => {
  it("returns null when no config anywhere", () => {
    const out = loadPolicyConfig({
      name: "aws",
      cwd: tmpCwd,
      home: tmpHome,
    });
    expect(out).toBeNull();
  });

  it("loads home-only config", () => {
    writeHomeConfig("aws", "policy:\n  read: escalate\n");
    const out = loadPolicyConfig({ name: "aws", cwd: tmpCwd, home: tmpHome });
    expect(out?.rules.read).toBe("escalate");
  });

  it("repo-level wins over home-level", () => {
    writeHomeConfig("aws", "policy:\n  read: escalate\n");
    writeRepoConfig("aws", "policy:\n  read: denied\n");
    const out = loadPolicyConfig({ name: "aws", cwd: tmpCwd, home: tmpHome });
    expect(out?.rules.read).toBe("denied");
  });

  it("explicit path overrides discovery", () => {
    writeHomeConfig("aws", "policy:\n  read: escalate\n");
    const explicitPath = path.join(tmpCwd, "custom.yaml");
    fs.writeFileSync(explicitPath, "policy:\n  read: denied\n");
    const out = loadPolicyConfig({
      name: "aws",
      cwd: tmpCwd,
      home: tmpHome,
      explicitPath,
    });
    expect(out?.rules.read).toBe("denied");
  });

  it("invalid YAML surfaces a descriptive error", () => {
    writeHomeConfig("aws", "policy: {\n  read: escalate\n"); // unclosed mapping
    expect(() =>
      loadPolicyConfig({ name: "aws", cwd: tmpCwd, home: tmpHome }),
    ).toThrow(/Failed to parse YAML/);
  });

  it("passes floorAspects through to validation", () => {
    writeHomeConfig("db", "policy:\n  aspects:\n    ddl: success\n");
    expect(() =>
      loadPolicyConfig({
        name: "db",
        cwd: tmpCwd,
        home: tmpHome,
        floorAspects: ["ddl"],
      }),
    ).toThrow(/safety floor/);
  });
});
