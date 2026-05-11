import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureSettingsHook,
  hasConnectorGateHook,
} from "../../../plugins/connector-creator/skills/connector-creator/lib/settings-wiring.mjs";

describe("settings-wiring", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("creates settings.json + adds hook when neither exists", () => {
    const settingsPath = path.join(scope, ".claude", "settings.json");
    const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
    ensureSettingsHook(settingsPath, gatePath);
    expect(fs.existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(JSON.stringify(parsed)).toContain("connector-gate.mjs");
  });

  it("is idempotent — second call does not duplicate", () => {
    const settingsPath = path.join(scope, ".claude", "settings.json");
    const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
    ensureSettingsHook(settingsPath, gatePath);
    ensureSettingsHook(settingsPath, gatePath);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(parsed.hooks.PreToolUse[0].hooks.length).toBe(1);
  });

  it("merges into existing settings.json without losing other keys", () => {
    const settingsPath = path.join(scope, ".claude", "settings.json");
    fs.mkdirSync(path.join(scope, ".claude"), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ otherKey: "preserved", hooks: { SessionEnd: [] } }),
    );
    const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
    ensureSettingsHook(settingsPath, gatePath);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(parsed.otherKey).toBe("preserved");
    expect(parsed.hooks.SessionEnd).toEqual([]);
    expect(parsed.hooks.PreToolUse).toBeDefined();
  });

  it("creates a backup before writing", () => {
    const settingsPath = path.join(scope, ".claude", "settings.json");
    fs.mkdirSync(path.join(scope, ".claude"), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
    ensureSettingsHook(settingsPath, gatePath);
    const backups = fs
      .readdirSync(path.join(scope, ".claude"))
      .filter((f) => f.startsWith("settings.json.bak-"));
    expect(backups.length).toBe(1);
  });

  it("hasConnectorGateHook detects existing wiring", () => {
    const settingsPath = path.join(scope, ".claude", "settings.json");
    const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
    expect(hasConnectorGateHook(settingsPath, gatePath)).toBe(false);
    ensureSettingsHook(settingsPath, gatePath);
    expect(hasConnectorGateHook(settingsPath, gatePath)).toBe(true);
  });
});
