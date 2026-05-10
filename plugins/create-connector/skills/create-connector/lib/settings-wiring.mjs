/**
 * settings-wiring.mjs — idempotent management of Claude Code's settings.json
 * to register the connector-gate.mjs PreToolUse hook.
 *
 * Two functions:
 *   - ensureSettingsHook(settingsPath, gatePath)
 *   - hasConnectorGateHook(settingsPath, gatePath)
 *
 * Backs up the file with a timestamped suffix before any write.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function ensureSettingsHook(settingsPath, gatePath) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });

  let parsed = {};
  if (fs.existsSync(settingsPath)) {
    backup(settingsPath);
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  }

  if (!parsed.hooks) parsed.hooks = {};
  if (!parsed.hooks.PreToolUse) parsed.hooks.PreToolUse = [];

  // Find an existing Bash matcher block; create one if missing.
  let block = parsed.hooks.PreToolUse.find((b) => b.matcher === "Bash");
  if (!block) {
    block = { matcher: "Bash", hooks: [] };
    parsed.hooks.PreToolUse.push(block);
  }
  if (!Array.isArray(block.hooks)) block.hooks = [];

  const entry = { type: "command", command: `node "${gatePath}"` };
  const exists = block.hooks.some(
    (h) =>
      h.type === "command" &&
      typeof h.command === "string" &&
      h.command.includes(gatePath),
  );
  if (!exists) block.hooks.push(entry);

  fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
}

export function hasConnectorGateHook(settingsPath, gatePath) {
  if (!fs.existsSync(settingsPath)) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return false;
  }
  const blocks = parsed.hooks?.PreToolUse ?? [];
  return blocks.some(
    (b) =>
      Array.isArray(b.hooks) &&
      b.hooks.some(
        (h) =>
          h.type === "command" &&
          typeof h.command === "string" &&
          h.command.includes(gatePath),
      ),
  );
}

function backup(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(filePath, `${filePath}.bak-${ts}`);
}
