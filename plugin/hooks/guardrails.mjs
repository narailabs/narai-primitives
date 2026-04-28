#!/usr/bin/env node
// hooks/guardrails.mjs — connector-hub PreToolUse unified guardrail.
//
// Reads enabled connectors from ~/.connectors/config.yaml (+ overlay), loads
// each enabled connector's plugin/hooks/guardrails.json manifest, and runs
// findBlockingRule from @narai/connector-toolkit against the Bash command.
// Fails open on every error — never a security boundary.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/** Try to import the toolkit's guardrail module. Resolution order favors the
 *  bundled layout (this hook is shipped inside narai-primitives) and falls
 *  back to the legacy @narai/connector-toolkit paths for back-compat. */
async function loadToolkit() {
  const candidates = [
    // 1. Bundle: this hook lives at narai-primitives/plugin/hooks/guardrails.mjs;
    //    toolkit is sibling at narai-primitives/dist/toolkit/guardrail.js
    join(__dirname, "..", "..", "dist", "toolkit", "guardrail.js"),
    // 2. Bundle installed as a Claude Code plugin
    process.env.CLAUDE_PLUGIN_DATA
      ? join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "narai-primitives", "dist", "toolkit", "guardrail.js")
      : null,
    // 3. Legacy: hub installed with @narai/connector-toolkit as a sibling node_module
    process.env.CLAUDE_PLUGIN_DATA
      ? join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "@narai", "connector-toolkit", "dist", "guardrail.js")
      : null,
    // 4. Legacy dev fallback
    join(homedir(), "src", "connectors", "connector-toolkit", "dist", "guardrail.js"),
  ].filter((p) => p !== null);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return await import(pathToFileURL(p).href);
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Minimal YAML scanner: extracts the `connectors:` block and returns
 * { name -> { enforce_hooks?: boolean, disable?: boolean } }. Top-level
 * `enforce_hooks:` default is also returned. Fail-open on any anomaly.
 */
function parseConnectorsBlock(text) {
  const result = { defaultEnforce: true, connectors: {} };
  const lines = text.split(/\r?\n/);

  // Top-level enforce_hooks (a line starting at column 0).
  for (const line of lines) {
    const m = line.match(/^enforce_hooks:\s*(true|false)\s*(#.*)?$/);
    if (m) {
      result.defaultEnforce = m[1] === "true";
      break;
    }
  }

  // Find the `connectors:` block. Parse name → { enforce_hooks, disable }.
  // Indent-agnostic: connector name is any non-zero-indent `<name>:` line;
  // child props must be more deeply indented than the name (tabs and any
  // space count work).
  let i = 0;
  while (i < lines.length) {
    if (/^connectors:\s*(#.*)?$/.test(lines[i])) {
      i++;
      while (i < lines.length) {
        const line = lines[i];
        if (line === "" || /^\s*#/.test(line)) {
          i++;
          continue;
        }
        // Stop when we leave the connectors block (de-indent to col 0).
        if (!/^\s/.test(line)) break;
        const nameMatch = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(#.*)?$/);
        if (nameMatch) {
          const baseIndent = nameMatch[1].length;
          const name = nameMatch[2];
          const childIndentRe = new RegExp(`^\\s{${baseIndent + 1},}`);
          const entry = {};
          i++;
          while (i < lines.length) {
            const sub = lines[i];
            if (sub === "" || /^\s*#/.test(sub)) {
              i++;
              continue;
            }
            // Stop at any line not indented deeper than the name.
            if (!childIndentRe.test(sub)) break;
            const eh = sub.match(/^\s+enforce_hooks:\s*(true|false)\s*(#.*)?$/);
            if (eh) entry.enforce_hooks = eh[1] === "true";
            const dis = sub.match(/^\s+disable:\s*(true|false)\s*(#.*)?$/);
            if (dis) entry.disable = dis[1] === "true";
            i++;
          }
          result.connectors[name] = entry;
          continue;
        }
        i++;
      }
      break;
    }
    i++;
  }

  return result;
}

function loadConfigs() {
  const merged = { defaultEnforce: true, connectors: {} };
  const userPath = join(homedir(), ".connectors", "config.yaml");
  const repoPath = join(process.cwd(), ".connectors", "config.yaml");
  for (const p of [userPath, repoPath]) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseConnectorsBlock(readFileSync(p, "utf-8"));
      // repo overlays user — last write wins.
      merged.defaultEnforce = parsed.defaultEnforce;
      for (const [name, entry] of Object.entries(parsed.connectors)) {
        merged.connectors[name] = { ...(merged.connectors[name] ?? {}), ...entry };
      }
    } catch {
      // fail open on parse error
    }
  }
  return merged;
}

/**
 * Locate plugin/hooks/guardrails.json for a connector.
 *
 * Intentionally narrower than the toolkit's `resolveAgentCli` — manifests live
 * at `plugin/hooks/guardrails.json` rather than `dist/cli.js`, and the env-var
 * override is omitted because per-connector guardrail location isn't
 * operator-configurable for V1. If a third consumer of the same fallback shape
 * emerges, parametrize `resolveAgentCli` and remove this duplication.
 */
function findGuardrailManifestPath(name) {
  const base = `${name}-agent`;
  const candidates = [];
  // 0. Bundle: this hook is at narai-primitives/plugin/hooks/guardrails.mjs;
  //    connector hook manifests are at narai-primitives/plugins/<name>-agent/hooks/guardrails.json
  candidates.push(join(__dirname, "..", "..", "plugins", base, "hooks", "guardrails.json"));
  // 1. ~/.claude/plugins/cache/<name>-agent-plugin*/
  const cacheDir = join(homedir(), ".claude", "plugins", "cache");
  if (existsSync(cacheDir)) {
    try {
      for (const entry of readdirSync(cacheDir)) {
        if (entry.includes(`${base}-plugin`)) {
          candidates.push(join(cacheDir, entry, "plugin", "hooks", "guardrails.json"));
          // some installers drop hooks at the top of the plugin dir
          candidates.push(join(cacheDir, entry, "hooks", "guardrails.json"));
        }
      }
    } catch {
      /* fail open */
    }
  }
  // 2. sibling to the hub's CLAUDE_PLUGIN_DATA dir
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (data) {
    candidates.push(join(dirname(data), `${base}-plugin`, "plugin", "hooks", "guardrails.json"));
    candidates.push(join(dirname(data), `${base}-plugin`, "hooks", "guardrails.json"));
  }
  // 3. dev: ~/src/connectors/<name>-agent-connector/plugin/hooks/guardrails.json (legacy fallback)
  candidates.push(
    join(homedir(), "src", "connectors", `${name}-agent-connector`, "plugin", "hooks", "guardrails.json"),
  );
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const raw = readStdin();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload?.tool_name !== "Bash") return;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return;

  const toolkit = await loadToolkit();
  if (!toolkit) return; // toolkit unavailable → fail open
  const { findBlockingRule, defaultDenyMessage, loadGuardrailManifest } = toolkit;
  if (typeof findBlockingRule !== "function") return;

  const cfg = loadConfigs();
  const manifests = [];
  for (const [name, entry] of Object.entries(cfg.connectors)) {
    if (entry.disable === true) continue;
    const enforce = entry.enforce_hooks ?? cfg.defaultEnforce;
    if (enforce !== true) continue;
    const manifestPath = findGuardrailManifestPath(name);
    if (!manifestPath) continue;
    try {
      manifests.push(loadGuardrailManifest(manifestPath));
    } catch {
      // skip broken manifests silently
    }
  }
  if (manifests.length === 0) return;

  const match = findBlockingRule(command, manifests);
  if (!match) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: defaultDenyMessage(match),
      },
    }),
  );
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`connector-hub guardrails: fail-open (${(err && err.message) || err})\n`);
  process.exit(0);
}
