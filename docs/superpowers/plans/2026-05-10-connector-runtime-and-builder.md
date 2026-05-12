# Connector Runtime + Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ~460 lines of duplicated hook config across 7 builtin Claude Code plugins with a shared dispatcher; add a standalone runtime + upgraded `create-connector` skill so users can ship connectors locally without Claude Code plugin packaging.

**Architecture:** Two phases land in one PR. **Phase A** (Tasks 1–7) introduces `plugin-hooks/dispatcher.mjs` and migrates each builtin plugin to use it. **Phase B** (Tasks 8–13) ships a self-contained `connector-gate.mjs` template + settings.json wiring + adaptive `create-connector` skill with 5 flavor recipes (api-wrapper, shell-gate, composite, knowledge, custom). Phase B does not depend on Phase A.

**Tech Stack:** Node 20 ESM, TypeScript (for src + tests), Vitest, Zod, js-yaml, native FormData. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-10-connector-runtime-and-builder-design.md`

---

## File Structure

```
narai-primitives/
├── plugin-hooks/                                      ← Phase A
│   ├── dispatcher.mjs                                 (NEW)
│   ├── plugin-config.mjs                              (NEW: parser)
│   ├── session-summary.mjs                            (existing)
│   ├── stale-summarize.mjs                            (existing)
│   └── usage-record.mjs                               (existing)
├── plugins/
│   ├── aws-agent/
│   │   ├── plugin-config.json                         (NEW: ~5 lines)
│   │   ├── hooks/hooks.json                           (REWRITE: ~24 lines)
│   │   └── hooks/reminder.mjs                         (DELETE)
│   ├── confluence-agent/                              (same shape)
│   ├── db-agent/                                      (same + keeps db-guard)
│   ├── gcp-agent/                                     (same shape)
│   ├── github-agent/                                  (same shape)
│   ├── jira-agent/                                    (same shape)
│   ├── notion-agent/                                  (same shape)
│   └── create-connector/                              ← Phase B
│       └── skills/create-connector/
│           ├── SKILL.md                               (REWRITE: adaptive flow)
│           ├── assets/templates/
│           │   ├── _runtime/connector-gate.mjs.tmpl   (NEW: standalone dispatcher)
│           │   ├── api-wrapper/                       (REFACTOR existing)
│           │   ├── shell-gate/                        (NEW)
│           │   ├── composite/                         (NEW)
│           │   └── knowledge/                         (NEW)
│           ├── lib/
│           │   ├── settings-wiring.mjs                (NEW)
│           │   └── connector-registry.mjs             (NEW)
│           └── references/
│               ├── connector-contract.md              (NEW)
│               ├── flavor-authoring.md                (NEW)
│               └── research-patterns.md               (NEW)
└── tests/
    ├── plugin-hooks/
    │   ├── plugin-config.test.ts                      (NEW)
    │   ├── dispatcher.test.ts                         (NEW)
    │   └── smart-bootstrap.test.ts                    (NEW)
    └── plugins/connector-creator/
        ├── connector-gate.test.ts                     (NEW)
        ├── settings-wiring.test.ts                    (NEW)
        └── skill-end-to-end.test.ts                   (NEW)
```

---

# Phase A — Shared Dispatcher

## Task 1: Plugin-config parser

A plugin-config.json file lives in each builtin plugin and tells the dispatcher its identity. Define the shape; build a parser that validates and returns a typed object.

**Files:**
- Create: `plugin-hooks/plugin-config.mjs`
- Test: `tests/plugin-hooks/plugin-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plugin-hooks/plugin-config.test.ts
import { describe, it, expect } from "vitest";
import { parsePluginConfig } from "../../plugin-hooks/plugin-config.mjs";

describe("parsePluginConfig", () => {
  it("parses a minimal config", () => {
    const cfg = parsePluginConfig(JSON.stringify({ name: "jira" }));
    expect(cfg).toEqual({ name: "jira" });
  });

  it("parses with binPath", () => {
    const cfg = parsePluginConfig(
      JSON.stringify({
        name: "jira",
        binPath: "narai-primitives/dist/connectors/jira",
        kind: "connector",
      }),
    );
    expect(cfg.binPath).toBe("narai-primitives/dist/connectors/jira");
    expect(cfg.kind).toBe("connector");
  });

  it("rejects missing name", () => {
    expect(() => parsePluginConfig("{}")).toThrow(/name/);
  });

  it("rejects non-string name", () => {
    expect(() => parsePluginConfig(JSON.stringify({ name: 42 }))).toThrow(
      /name/,
    );
  });

  it("rejects unknown kind", () => {
    expect(() =>
      parsePluginConfig(JSON.stringify({ name: "x", kind: "weird" })),
    ).toThrow(/kind/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parsePluginConfig("not json")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/plugin-hooks/plugin-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```js
// plugin-hooks/plugin-config.mjs
/**
 * Parse and validate a plugin-config.json string.
 *
 * Shape:
 *   { name: string,
 *     binPath?: string,
 *     kind?: "connector" | "db" | "hook-only" }
 */
const VALID_KINDS = new Set(["connector", "db", "hook-only"]);

export function parsePluginConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`plugin-config.json: invalid JSON — ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("plugin-config.json: expected an object");
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error("plugin-config.json: 'name' must be a non-empty string");
  }
  if (parsed.binPath !== undefined && typeof parsed.binPath !== "string") {
    throw new Error("plugin-config.json: 'binPath' must be a string");
  }
  if (parsed.kind !== undefined && !VALID_KINDS.has(parsed.kind)) {
    throw new Error(
      `plugin-config.json: 'kind' must be one of ${[...VALID_KINDS].join(", ")}`,
    );
  }
  const out = { name: parsed.name };
  if (parsed.binPath !== undefined) out.binPath = parsed.binPath;
  if (parsed.kind !== undefined) out.kind = parsed.kind;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/plugin-hooks/plugin-config.test.ts`
Expected: PASS, 6 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/plugin-config.mjs tests/plugin-hooks/plugin-config.test.ts
git commit -m "feat(plugin-hooks): plugin-config.json parser"
```

---

## Task 2: Dispatcher event routing

Single dispatcher script that handles SessionStart, PreToolUse, PostToolUse, SessionEnd. Dispatches based on argv. Reads `${CLAUDE_PLUGIN_ROOT}/plugin-config.json`.

**Files:**
- Create: `plugin-hooks/dispatcher.mjs`
- Test: `tests/plugin-hooks/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plugin-hooks/dispatcher.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DISPATCHER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin-hooks",
  "dispatcher.mjs",
);

interface Result { stdout: string; stderr: string; exitCode: number }

async function runDispatcher(
  event: string,
  pluginRoot: string,
  pluginData: string,
  stdin = "",
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DISPATCHER, event], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_DATA: pluginData,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? -1 }),
    );
    proc.on("error", reject);
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

describe("dispatcher event routing", () => {
  let tmpRoot: string;
  let tmpData: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-root-"));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-data-"));
    fs.writeFileSync(
      path.join(tmpRoot, "plugin-config.json"),
      JSON.stringify({ name: "test-plugin" }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it("session-start exits 0", async () => {
    const r = await runDispatcher("session-start", tmpRoot, tmpData);
    expect(r.exitCode).toBe(0);
  });

  it("post-tool-use exits 0 with stdin payload", async () => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const r = await runDispatcher("post-tool-use", tmpRoot, tmpData, payload);
    expect(r.exitCode).toBe(0);
  });

  it("session-end exits 0", async () => {
    const r = await runDispatcher("session-end", tmpRoot, tmpData);
    expect(r.exitCode).toBe(0);
  });

  it("unknown event exits non-zero with stderr", async () => {
    const r = await runDispatcher("nope", tmpRoot, tmpData);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown/i);
  });

  it("missing plugin-config.json exits non-zero", async () => {
    fs.rmSync(path.join(tmpRoot, "plugin-config.json"));
    const r = await runDispatcher("session-start", tmpRoot, tmpData);
    expect(r.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: FAIL — `dispatcher.mjs` not found.

- [ ] **Step 3: Implement the dispatcher**

```js
// plugin-hooks/dispatcher.mjs
#!/usr/bin/env node
/**
 * Shared PreToolUse / PostToolUse / SessionStart / SessionEnd dispatcher
 * for narai-primitives builtin Claude Code plugins.
 *
 * Usage:
 *   node dispatcher.mjs <event>
 *
 * Where <event> is one of: session-start, pre-tool-use, post-tool-use,
 * session-end. Reads ${CLAUDE_PLUGIN_ROOT}/plugin-config.json for the
 * plugin's identity and routes to the appropriate handler.
 *
 * Best-effort: hook failures are logged to stderr but do not block.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePluginConfig } from "./plugin-config.mjs";

const VALID_EVENTS = new Set([
  "session-start",
  "pre-tool-use",
  "post-tool-use",
  "session-end",
]);

main().catch((err) => {
  process.stderr.write(`dispatcher: ${err?.message ?? err}\n`);
  process.exit(1);
});

async function main() {
  const event = process.argv[2];
  if (!VALID_EVENTS.has(event)) {
    process.stderr.write(
      `dispatcher: unknown event '${event}' (expected one of ${[...VALID_EVENTS].join(", ")})\n`,
    );
    process.exit(2);
  }

  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) {
    process.stderr.write("dispatcher: CLAUDE_PLUGIN_ROOT not set\n");
    process.exit(2);
  }

  const cfgPath = path.join(root, "plugin-config.json");
  if (!fs.existsSync(cfgPath)) {
    process.stderr.write(`dispatcher: missing ${cfgPath}\n`);
    process.exit(2);
  }
  const cfg = parsePluginConfig(fs.readFileSync(cfgPath, "utf-8"));

  switch (event) {
    case "session-start":
      await onSessionStart(cfg);
      break;
    case "pre-tool-use":
      await onPreToolUse(cfg);
      break;
    case "post-tool-use":
      await onPostToolUse(cfg);
      break;
    case "session-end":
      await onSessionEnd(cfg);
      break;
  }
  process.exit(0);
}

// Stubs filled in subsequent tasks.
async function onSessionStart(cfg) { /* Task 3 + 4 */ }
async function onPreToolUse(cfg) { /* Task 7 */ }
async function onPostToolUse(cfg) { /* Task 5 */ }
async function onSessionEnd(cfg) { /* Task 6 */ }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS, 5 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/dispatcher.mjs tests/plugin-hooks/dispatcher.test.ts
git commit -m "feat(plugin-hooks): dispatcher event-routing skeleton"
```

---

## Task 3: Smart bootstrap (sibling-plugin install dedup)

When a builtin plugin's SessionStart fires, check if any sibling plugin already has `narai-primitives` installed at the same version. If yes, skip the install (symlink the sibling's `node_modules`); if no, install normally.

**Files:**
- Modify: `plugin-hooks/dispatcher.mjs` (the `onSessionStart` body + helpers)
- Test: `tests/plugin-hooks/smart-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plugin-hooks/smart-bootstrap.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSiblingInstall } from "../../plugin-hooks/dispatcher.mjs";

describe("findSiblingInstall", () => {
  it("returns null when no siblings exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
    fs.mkdirSync(path.join(tmp, "alone"));
    expect(findSiblingInstall(path.join(tmp, "alone"), "1.0.0")).toBeNull();
    fs.rmSync(tmp, { recursive: true });
  });

  it("returns sibling path when version matches", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
    const me = path.join(tmp, "me");
    const sibling = path.join(tmp, "sibling");
    fs.mkdirSync(me);
    fs.mkdirSync(
      path.join(sibling, "node_modules", "narai-primitives"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(sibling, "node_modules", "narai-primitives", "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    expect(findSiblingInstall(me, "1.0.0")).toBe(
      path.join(sibling, "node_modules"),
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it("returns null when sibling has different version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
    const me = path.join(tmp, "me");
    const sibling = path.join(tmp, "sibling");
    fs.mkdirSync(me);
    fs.mkdirSync(
      path.join(sibling, "node_modules", "narai-primitives"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(sibling, "node_modules", "narai-primitives", "package.json"),
      JSON.stringify({ version: "0.9.0" }),
    );
    expect(findSiblingInstall(me, "1.0.0")).toBeNull();
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/plugin-hooks/smart-bootstrap.test.ts`
Expected: FAIL — `findSiblingInstall` not exported.

- [ ] **Step 3: Implement and export the helper**

In `plugin-hooks/dispatcher.mjs`, add and export:

```js
/**
 * Walk siblings of `pluginDataDir` looking for a `node_modules/narai-primitives`
 * at `wantedVersion`. Returns the matched node_modules path, or null if no
 * usable sibling found. Used to skip redundant npm install when N builtin
 * plugins are loaded in the same Claude Code session.
 */
export function findSiblingInstall(pluginDataDir, wantedVersion) {
  const parent = path.dirname(pluginDataDir);
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(parent, entry.name);
    if (candidate === pluginDataDir) continue;
    const pkgJson = path.join(
      candidate,
      "node_modules",
      "narai-primitives",
      "package.json",
    );
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
      if (meta.version === wantedVersion) {
        return path.join(candidate, "node_modules");
      }
    } catch {
      continue;
    }
  }
  return null;
}
```

Also update `onSessionStart`:

```js
async function onSessionStart(cfg) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginRoot || !pluginData) return;

  const rootPkg = path.join(pluginRoot, "package.json");
  if (!fs.existsSync(rootPkg)) return;
  const rootMeta = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
  const wantVersion = rootMeta.dependencies?.["narai-primitives"]
    ?? rootMeta.version;

  fs.mkdirSync(pluginData, { recursive: true });

  const myInstall = path.join(pluginData, "node_modules", "narai-primitives");
  if (fs.existsSync(myInstall)) {
    const installed = JSON.parse(
      fs.readFileSync(path.join(myInstall, "package.json"), "utf-8"),
    );
    if (installed.version === wantVersion) {
      // Already installed at the right version; skip.
      return;
    }
  }

  const sibling = findSiblingInstall(pluginData, wantVersion);
  if (sibling !== null) {
    // Symlink our node_modules to the sibling's. Best-effort.
    try {
      const myNodeModules = path.join(pluginData, "node_modules");
      if (fs.existsSync(myNodeModules)) {
        fs.rmSync(myNodeModules, { recursive: true, force: true });
      }
      fs.symlinkSync(sibling, myNodeModules, "dir");
      return;
    } catch {
      // Fall through to install.
    }
  }

  // No sibling — copy package.json and install.
  fs.copyFileSync(rootPkg, path.join(pluginData, "package.json"));
  const { spawnSync } = await import("node:child_process");
  spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: pluginData,
    stdio: "inherit",
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/plugin-hooks/smart-bootstrap.test.ts`
Expected: PASS, 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/dispatcher.mjs tests/plugin-hooks/smart-bootstrap.test.ts
git commit -m "feat(plugin-hooks): smart bootstrap with sibling-install dedup"
```

---

## Task 4: Reminder + stale-summarize integration

Inside `onSessionStart` (after bootstrap), invoke the existing toolkit `evaluateNudge` and the existing `stale-summarize.mjs` script. This replaces the per-plugin `reminder.mjs` files.

**Files:**
- Modify: `plugin-hooks/dispatcher.mjs`
- Test: `tests/plugin-hooks/dispatcher.test.ts` (add cases)

- [ ] **Step 1: Write failing tests for the integration**

Append to `tests/plugin-hooks/dispatcher.test.ts`:

```ts
describe("dispatcher session-start integrations", () => {
  let tmpRoot: string;
  let tmpData: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-int-root-"));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-int-data-"));
    fs.writeFileSync(
      path.join(tmpRoot, "plugin-config.json"),
      JSON.stringify({ name: "jira" }),
    );
    fs.writeFileSync(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({
        name: "jira-agent",
        version: "1.0.0",
        dependencies: { "narai-primitives": "1.0.0" },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it("invokes nudge + stale-summarize without crashing on missing toolkit", async () => {
    // No node_modules in tmpData — dispatcher should swallow errors.
    const r = await runDispatcher("session-start", tmpRoot, tmpData);
    expect(r.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify the new test passes (regression check on prior steps)**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS for prior tests; new test PASSES because we've made onSessionStart best-effort.

- [ ] **Step 3: Add nudge + stale-summarize calls to onSessionStart**

Modify `onSessionStart` in `plugin-hooks/dispatcher.mjs` — append after the bootstrap block:

```js
  // Best-effort: emit nudge banner if the toolkit is reachable.
  try {
    const reminderPath = path.join(
      pluginData,
      "node_modules",
      "narai-primitives",
      "dist",
      "toolkit",
      "plugin",
      "reminder.js",
    );
    if (fs.existsSync(reminderPath)) {
      const mod = await import(reminderPath);
      const decision = mod.evaluateNudge({ connectors: [cfg.name] });
      if (decision.nudge) process.stdout.write(decision.banner + "\n");
    }
  } catch (err) {
    process.stderr.write(`dispatcher: nudge failed (${err.message})\n`);
  }

  // Best-effort: stale-summarize.
  try {
    const stalePath = path.join(
      pluginData,
      "node_modules",
      "narai-primitives",
      "plugin-hooks",
      "stale-summarize.mjs",
    );
    if (fs.existsSync(stalePath)) {
      process.env.USAGE_CONNECTOR_NAME = cfg.name;
      await import(stalePath);
    }
  } catch (err) {
    process.stderr.write(`dispatcher: stale-summarize failed (${err.message})\n`);
  }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: All tests pass, including the new integration test.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/dispatcher.mjs tests/plugin-hooks/dispatcher.test.ts
git commit -m "feat(plugin-hooks): nudge + stale-summarize via dispatcher"
```

---

## Task 5: PostToolUse usage-record integration

`onPostToolUse` invokes the existing `usage-record.mjs` from the shared `plugin-hooks/` dir, with `USAGE_CONNECTOR_NAME` set from `cfg.name` and `USAGE_BIN_HINT` derived from `cfg.binPath`.

**Files:**
- Modify: `plugin-hooks/dispatcher.mjs` (`onPostToolUse`)
- Test: `tests/plugin-hooks/dispatcher.test.ts` (add cases)

- [ ] **Step 1: Write failing tests**

Append:

```ts
describe("dispatcher post-tool-use", () => {
  it("post-tool-use sets USAGE_CONNECTOR_NAME from cfg.name and exits 0", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({
          name: "jira",
          binPath: "narai-primitives/dist/connectors/jira",
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      });
      const r = await runDispatcher("post-tool-use", tmpRoot, tmpData, payload);
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (or passes vacuously)**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS (best-effort; no crash). Verify the integration is wired in Step 3 anyway — without the wire, `usage-record.mjs` isn't called.

- [ ] **Step 3: Wire `onPostToolUse`**

Replace the `onPostToolUse` stub:

```js
async function onPostToolUse(cfg) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return;
  const usagePath = path.join(
    pluginData,
    "node_modules",
    "narai-primitives",
    "plugin-hooks",
    "usage-record.mjs",
  );
  if (!fs.existsSync(usagePath)) return;
  process.env.USAGE_CONNECTOR_NAME = cfg.name;
  if (cfg.binPath) process.env.USAGE_BIN_HINT = cfg.binPath;
  try {
    await import(usagePath);
  } catch (err) {
    process.stderr.write(`dispatcher: usage-record failed (${err.message})\n`);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/dispatcher.mjs tests/plugin-hooks/dispatcher.test.ts
git commit -m "feat(plugin-hooks): post-tool-use usage-record via dispatcher"
```

---

## Task 6: SessionEnd session-summary

Mirror Task 5 for `onSessionEnd`.

**Files:**
- Modify: `plugin-hooks/dispatcher.mjs` (`onSessionEnd`)

- [ ] **Step 1: Write failing test**

Append to `tests/plugin-hooks/dispatcher.test.ts`:

```ts
describe("dispatcher session-end", () => {
  it("session-end exits 0 even when toolkit is missing", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "se-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "se-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      const r = await runDispatcher("session-end", tmpRoot, tmpData);
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, see PASS for the no-crash case (proceed to wire anyway)**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire `onSessionEnd`**

```js
async function onSessionEnd(cfg) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return;
  const summaryPath = path.join(
    pluginData,
    "node_modules",
    "narai-primitives",
    "plugin-hooks",
    "session-summary.mjs",
  );
  if (!fs.existsSync(summaryPath)) return;
  process.env.USAGE_CONNECTOR_NAME = cfg.name;
  try {
    await import(summaryPath);
  } catch (err) {
    process.stderr.write(`dispatcher: session-summary failed (${err.message})\n`);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/dispatcher.mjs tests/plugin-hooks/dispatcher.test.ts
git commit -m "feat(plugin-hooks): session-end summary via dispatcher"
```

---

## Task 7: PreToolUse — db-guard delegation + user-connector gate scan

`onPreToolUse` does two things, in order: (1) for `kind: "db"`, run the existing db-guard logic; (2) for any plugin, scan `<scope>/.connectors/connectors/*/gates.json` and apply matching rules. Decision precedence: deny > ask > allow.

**Files:**
- Modify: `plugin-hooks/dispatcher.mjs` (`onPreToolUse`)
- Test: `tests/plugin-hooks/dispatcher.test.ts` (add cases)

- [ ] **Step 1: Write failing test for db-guard delegation**

Append:

```ts
describe("dispatcher pre-tool-use db-guard", () => {
  it("for kind=db, denies if db-guard pattern matches", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-db-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-db-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "db", kind: "db" }),
      );
      // Synthetic db-guard manifest: deny psql.
      fs.mkdirSync(path.join(tmpRoot, "hooks"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "hooks", "guardrails.json"),
        JSON.stringify({
          rules: [{ pattern: "^psql\\b", message: "Use db-agent." }],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "psql -c 'select 1'" },
      });
      const r = await runDispatcher("pre-tool-use", tmpRoot, tmpData, payload);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});

describe("dispatcher pre-tool-use user-connector gates", () => {
  it("applies gates from .connectors/connectors/*/gates.json", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-gates-home-"));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-gates-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-gates-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      // Synthetic user gate at $HOME/.connectors/connectors/test/gates.json
      const gateDir = path.join(
        tmpHome,
        ".connectors",
        "connectors",
        "test",
      );
      fs.mkdirSync(gateDir, { recursive: true });
      fs.writeFileSync(
        path.join(gateDir, "gates.json"),
        JSON.stringify({
          rules: [
            {
              name: "deny_x",
              decision: "deny",
              reason: "blocked",
              pattern: "^echo deny",
            },
          ],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo deny it" },
      });
      const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
        env: {
          ...process.env,
          HOME: tmpHome,
          CLAUDE_PLUGIN_ROOT: tmpRoot,
          CLAUDE_PLUGIN_DATA: tmpData,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stdin.write(payload);
      proc.stdin.end();
      await new Promise<void>((resolve) =>
        proc.on("close", () => resolve()),
      );
      const out = JSON.parse(stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, see fails**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: FAIL — `onPreToolUse` is still a stub.

- [ ] **Step 3: Implement `onPreToolUse`**

```js
async function onPreToolUse(cfg) {
  const stdin = await readStdin();
  if (!stdin) return;
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return;
  }
  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return;

  const decisions = [];

  // 1. db-guard (only if kind=db)
  if (cfg.kind === "db") {
    const guardrailsPath = path.join(
      process.env.CLAUDE_PLUGIN_ROOT,
      "hooks",
      "guardrails.json",
    );
    if (fs.existsSync(guardrailsPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(guardrailsPath, "utf-8"));
        for (const rule of manifest.rules ?? []) {
          if (new RegExp(rule.pattern).test(command)) {
            decisions.push({
              decision: "deny",
              reason: rule.message ?? "blocked by db-agent guardrail",
            });
            break;
          }
        }
      } catch (err) {
        process.stderr.write(`dispatcher: db-guard failed (${err.message})\n`);
      }
    }
  }

  // 2. user-connector gates
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  for (const root of [home, cwd]) {
    const gatesDir = path.join(root, ".connectors", "connectors");
    if (!fs.existsSync(gatesDir)) continue;
    const slugs = fs.readdirSync(gatesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const slug of slugs) {
      const gatesFile = path.join(gatesDir, slug, "gates.json");
      if (!fs.existsSync(gatesFile)) continue;
      try {
        const gateCfg = JSON.parse(fs.readFileSync(gatesFile, "utf-8"));
        for (const rule of gateCfg.rules ?? []) {
          if (
            !["deny", "ask", "allow"].includes(rule.decision) ||
            typeof rule.pattern !== "string"
          ) continue;
          if (new RegExp(rule.pattern).test(command)) {
            decisions.push({
              decision: rule.decision,
              reason: rule.reason ?? `${slug} gate: ${rule.name}`,
            });
          }
        }
      } catch (err) {
        process.stderr.write(
          `dispatcher: gate scan failed for ${gatesFile} (${err.message})\n`,
        );
      }
    }
  }

  if (decisions.length === 0) return;
  // Strictness rank: deny > ask > allow.
  const rank = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision] - rank[a.decision]);
  const winner = decisions[0];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: winner.decision,
      permissionDecisionReason: winner.reason,
    },
  }));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/plugin-hooks/dispatcher.test.ts`
Expected: PASS, all dispatcher tests including new pre-tool-use cases.

- [ ] **Step 5: Commit**

```sh
git add plugin-hooks/dispatcher.mjs tests/plugin-hooks/dispatcher.test.ts
git commit -m "feat(plugin-hooks): pre-tool-use db-guard + user-connector gate scan"
```

---

## Task 8: Migrate `aws-agent` to dispatcher

Canary plugin migration — smallest surface, no special PreToolUse. After this lands, the same recipe applies to confluence/gcp/github/jira/notion.

**Files:**
- Create: `plugins/aws-connector/plugin-config.json`
- Modify: `plugins/aws-connector/hooks/hooks.json`
- Delete: `plugins/aws-connector/hooks/reminder.mjs`

- [ ] **Step 1: Add `plugins/aws-connector/plugin-config.json`**

```json
{
  "name": "aws",
  "binPath": "narai-primitives/dist/connectors/aws"
}
```

- [ ] **Step 2: Replace `plugins/aws-connector/hooks/hooks.json`**

Read the current file first to confirm the existing shape, then overwrite:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" session-start"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" post-tool-use"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" session-end"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Delete `plugins/aws-connector/hooks/reminder.mjs`**

```sh
rm plugins/aws-connector/hooks/reminder.mjs
```

- [ ] **Step 4: Smoke-test the dispatcher with aws-agent's plugin-config**

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | \
  CLAUDE_PLUGIN_ROOT=$(pwd)/plugins/aws-connector \
  CLAUDE_PLUGIN_DATA=$(mktemp -d) \
  node plugin-hooks/dispatcher.mjs post-tool-use
```

Expected: exit 0, no stdout decision, no stderr.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass; existing aws-agent tests unchanged.

- [ ] **Step 6: Commit**

```sh
git add plugins/aws-connector/plugin-config.json plugins/aws-connector/hooks/hooks.json
git rm plugins/aws-connector/hooks/reminder.mjs
git commit -m "feat(aws-agent): migrate to shared dispatcher"
```

---

## Task 9: Migrate confluence/gcp/github/jira/notion

Apply the same migration to the 5 remaining read-only plugins. Each follows the exact same shape as Task 8; only the connector name + binPath differs.

**Files (×5):**
- Create: `plugins/<x>-agent/plugin-config.json`
- Modify: `plugins/<x>-agent/hooks/hooks.json`
- Delete: `plugins/<x>-agent/hooks/reminder.mjs`

| Plugin | name | binPath |
|---|---|---|
| confluence-agent | `confluence` | `narai-primitives/dist/connectors/confluence` |
| gcp-agent | `gcp` | `narai-primitives/dist/connectors/gcp` |
| github-agent | `github` | `narai-primitives/dist/connectors/github` |
| jira-agent | `jira` | `narai-primitives/dist/connectors/jira` |
| notion-agent | `notion` | `narai-primitives/dist/connectors/notion` |

- [ ] **Step 1: For each of confluence/gcp/github/jira/notion, repeat Task 8 steps 1-4 with the values from the table above**

For each plugin:
- Create `plugin-config.json` with the right `name` + `binPath`.
- Overwrite `hooks/hooks.json` with the same template as aws-agent.
- Delete the per-plugin `hooks/reminder.mjs`.
- Run the smoke test.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 3: Commit (one commit covering all 5 — they're mechanically identical)**

```sh
git add plugins/confluence-connector/plugin-config.json plugins/confluence-connector/hooks/hooks.json
git rm plugins/confluence-connector/hooks/reminder.mjs
git add plugins/gcp-connector/plugin-config.json plugins/gcp-connector/hooks/hooks.json
git rm plugins/gcp-connector/hooks/reminder.mjs
git add plugins/github-connector/plugin-config.json plugins/github-connector/hooks/hooks.json
git rm plugins/github-connector/hooks/reminder.mjs
git add plugins/jira-connector/plugin-config.json plugins/jira-connector/hooks/hooks.json
git rm plugins/jira-connector/hooks/reminder.mjs
git add plugins/notion-connector/plugin-config.json plugins/notion-connector/hooks/hooks.json
git rm plugins/notion-connector/hooks/reminder.mjs
git commit -m "feat(builtin-plugins): migrate confluence/gcp/github/jira/notion to dispatcher"
```

---

## Task 10: Migrate `db-agent` (preserve PreToolUse)

`db-agent` is the only builtin plugin with a `PreToolUse` hook today (`db-guard.mjs`). The dispatcher already handles `kind: "db"` for that case; the migration adds a `PreToolUse` entry pointing at `dispatcher.mjs pre-tool-use` and sets `kind: "db"` in the plugin-config.

**Files:**
- Create: `plugins/db-connector/plugin-config.json`
- Modify: `plugins/db-connector/hooks/hooks.json`
- Delete: `plugins/db-connector/hooks/reminder.mjs`
- Keep: `plugins/db-connector/hooks/guardrails.json` (read by dispatcher)
- Delete: `plugins/db-connector/hooks/db-guard.mjs` (logic absorbed into dispatcher)

- [ ] **Step 1: Add `plugins/db-connector/plugin-config.json`**

```json
{
  "name": "db",
  "kind": "db",
  "binPath": "narai-primitives/dist/connectors/db"
}
```

- [ ] **Step 2: Replace `plugins/db-connector/hooks/hooks.json`**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" session-start"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" pre-tool-use"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" post-tool-use"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" session-end"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Delete the old per-plugin scripts**

```sh
rm plugins/db-connector/hooks/reminder.mjs
rm plugins/db-connector/hooks/db-guard.mjs
```

(Keep `guardrails.json` — the dispatcher reads it.)

- [ ] **Step 4: Smoke-test the deny path against the migrated plugin**

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"psql foo"}}' | \
  CLAUDE_PLUGIN_ROOT=$(pwd)/plugins/db-connector \
  CLAUDE_PLUGIN_DATA=$(mktemp -d) \
  node plugin-hooks/dispatcher.mjs pre-tool-use
```

Expected: stdout JSON with `permissionDecision: "deny"`, exit 0.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```sh
git add plugins/db-connector/plugin-config.json plugins/db-connector/hooks/hooks.json
git rm plugins/db-connector/hooks/reminder.mjs plugins/db-connector/hooks/db-guard.mjs
git commit -m "feat(db-agent): migrate to dispatcher (PreToolUse + db-guard absorbed)"
```

---

# Phase B — User-side runtime + skill upgrade

## Task 11: Standalone `connector-gate.mjs` template

Self-contained, zero-npm-dep dispatcher stamped at `<scope>/.connectors/connector-gate.mjs` by the create-connector skill. Reads `<scope>/.connectors/connectors/*/gates.json` and emits a permission decision.

**Files:**
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/_runtime/connector-gate.mjs.tmpl`
- Test: `tests/plugins/connector-creator/connector-gate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/plugins/connector-creator/connector-gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.resolve(
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
  "_runtime",
  "connector-gate.mjs.tmpl",
);

async function runGate(
  scopeRoot: string,
  payload: object,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [TEMPLATE], {
      env: { ...process.env, NARAI_GATE_SCOPE: scopeRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? -1 }),
    );
    proc.on("error", reject);
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

describe("connector-gate template", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scope-"));
    fs.mkdirSync(path.join(scope, ".connectors", "connectors"), {
      recursive: true,
    });
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("emits no decision when no connectors exist", async () => {
    const r = await runGate(scope, {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("emits deny when a connector's gates.json matches", async () => {
    const dir = path.join(scope, ".connectors", "connectors", "test");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gates.json"),
      JSON.stringify({
        rules: [
          {
            name: "deny_x",
            decision: "deny",
            reason: "blocked",
            pattern: "^echo deny",
          },
        ],
      }),
    );
    const r = await runGate(scope, {
      tool_name: "Bash",
      tool_input: { command: "echo deny it" },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("ignores non-Bash tools", async () => {
    const r = await runGate(scope, {
      tool_name: "Read",
      tool_input: { file_path: "/foo" },
    });
    expect(r.stdout).toBe("");
  });

  it("strictest decision wins across multiple connectors", async () => {
    const c1 = path.join(scope, ".connectors", "connectors", "c1");
    const c2 = path.join(scope, ".connectors", "connectors", "c2");
    fs.mkdirSync(c1, { recursive: true });
    fs.mkdirSync(c2, { recursive: true });
    fs.writeFileSync(
      path.join(c1, "gates.json"),
      JSON.stringify({
        rules: [
          { name: "ask", decision: "ask", reason: "?", pattern: "^echo" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(c2, "gates.json"),
      JSON.stringify({
        rules: [
          { name: "deny", decision: "deny", reason: "!", pattern: "^echo" },
        ],
      }),
    );
    const r = await runGate(scope, {
      tool_name: "Bash",
      tool_input: { command: "echo whatever" },
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
```

- [ ] **Step 2: Run, see fail**

Run: `npx vitest run tests/plugins/connector-creator/connector-gate.test.ts`
Expected: FAIL — template file not found.

- [ ] **Step 3: Implement the template**

```js
// plugins/connector-creator/skills/create-connector/assets/templates/_runtime/connector-gate.mjs.tmpl
#!/usr/bin/env node
/**
 * connector-gate.mjs — auto-discovers user connectors at
 * <scope>/.connectors/connectors/*\/gates.json and applies the rules at
 * Claude Code PreToolUse on Bash.
 *
 * Scope is resolved from NARAI_GATE_SCOPE (set by Claude Code's hook
 * invocation), or falls back to the parent directory of this script.
 *
 * Output shape (per Claude Code hook contract):
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                           permissionDecision: "allow"|"deny"|"ask",
 *                           permissionDecisionReason: "..." } }
 *
 * Decision precedence: deny > ask > allow.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

main().catch((err) => {
  process.stderr.write(`connector-gate: ${err?.message ?? err}\n`);
  process.exit(0);
});

async function main() {
  const payload = await readStdinJson();
  if (payload === null) return;
  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return;

  const scope = resolveScope();
  const decisions = scanConnectors(scope, command);
  if (decisions.length === 0) return;

  const rank = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision] - rank[a.decision]);
  const winner = decisions[0];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: winner.decision,
      permissionDecisionReason: winner.reason,
    },
  }));
}

function resolveScope() {
  if (process.env.NARAI_GATE_SCOPE) return process.env.NARAI_GATE_SCOPE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.dirname(path.dirname(here)); // …/<scope>/.connectors → <scope>
}

function scanConnectors(scope, command) {
  const root = path.join(scope, ".connectors", "connectors");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const slug of fs.readdirSync(root)) {
    const file = path.join(root, slug, "gates.json");
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
      for (const rule of cfg.rules ?? []) {
        if (
          !["deny", "ask", "allow"].includes(rule.decision) ||
          typeof rule.pattern !== "string"
        ) continue;
        let re;
        try { re = new RegExp(rule.pattern); } catch { continue; }
        for (const segment of splitCompound(command)) {
          if (re.test(segment)) {
            out.push({
              decision: rule.decision,
              reason: rule.reason ?? `${slug}: ${rule.name ?? "rule"}`,
            });
            break;
          }
        }
      }
    } catch (err) {
      process.stderr.write(`connector-gate: bad ${file} (${err.message})\n`);
    }
  }
  return out;
}

function splitCompound(cmd) {
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts
    .map((p) => stripPrefix(p.trim()))
    .filter((p) => p.length > 0);
}

function stripPrefix(s) {
  let cur = s;
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cur)) {
    cur = cur.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return cur.replace(/^(sudo|nice|time)\s+/, "");
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (raw.length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugins/connector-creator/connector-gate.test.ts`
Expected: PASS, 4 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/assets/templates/_runtime/connector-gate.mjs.tmpl tests/plugins/connector-creator/connector-gate.test.ts
git commit -m "feat(create-connector): standalone connector-gate.mjs template"
```

---

## Task 12: Settings.json wiring helper

Helper that idempotently adds the user's PreToolUse hook entry to `.claude/settings.json` (project) or `~/.claude/settings.json` (user). Backs up before writing; detects conflicts.

**Files:**
- Create: `plugins/connector-creator/skills/create-connector/lib/settings-wiring.mjs`
- Test: `tests/plugins/connector-creator/settings-wiring.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/plugins/connector-creator/settings-wiring.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureSettingsHook,
  hasConnectorGateHook,
} from "../../../plugins/connector-creator/skills/create-connector/lib/settings-wiring.mjs";

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
```

- [ ] **Step 2: Run, see fail**

Run: `npx vitest run tests/plugins/connector-creator/settings-wiring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```js
// plugins/connector-creator/skills/create-connector/lib/settings-wiring.mjs
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
    (h) => h.type === "command" && typeof h.command === "string" &&
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
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  fs.copyFileSync(filePath, `${filePath}.bak-${ts}`);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugins/connector-creator/settings-wiring.test.ts`
Expected: PASS, 5 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/lib/settings-wiring.mjs tests/plugins/connector-creator/settings-wiring.test.ts
git commit -m "feat(create-connector): settings.json wiring helper"
```

---

## Task 13: Connector registry helper (`config.yaml` updates)

Helper that appends a connector entry to `<scope>/.connectors/config.yaml`, creating the file if needed.

**Files:**
- Create: `plugins/connector-creator/skills/create-connector/lib/connector-registry.mjs`
- Test: `tests/plugins/connector-creator/connector-registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/plugins/connector-creator/connector-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerConnector } from "../../../plugins/connector-creator/skills/create-connector/lib/connector-registry.mjs";

describe("connector-registry", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
    fs.mkdirSync(path.join(scope, ".connectors"), { recursive: true });
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("creates config.yaml when missing", () => {
    registerConnector(scope, "stripe", {
      skill: "/abs/path/to/stripe",
      bin: "/abs/path/to/stripe/bin/stripe",
    });
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    expect(cfg).toContain("stripe:");
    expect(cfg).toContain("/abs/path/to/stripe");
  });

  it("appends to existing config.yaml without duplicating", () => {
    fs.writeFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "connectors:\n  existing:\n    skill: /old\n    enabled: true\n",
    );
    registerConnector(scope, "stripe", {
      skill: "/new/path",
      bin: "/new/bin",
    });
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    expect(cfg).toContain("existing:");
    expect(cfg).toContain("stripe:");
    expect(cfg).toContain("/new/path");
  });

  it("is idempotent — running twice does not duplicate the entry", () => {
    registerConnector(scope, "stripe", {
      skill: "/abs/path",
      bin: "/abs/bin",
    });
    registerConnector(scope, "stripe", {
      skill: "/abs/path",
      bin: "/abs/bin",
    });
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    const matches = cfg.match(/^\s+stripe:/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, see fail**

Run: `npx vitest run tests/plugins/connector-creator/connector-registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// plugins/connector-creator/skills/create-connector/lib/connector-registry.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

/**
 * Register a connector under <scope>/.connectors/config.yaml.
 *
 * Creates the file with `connectors: {}` if missing. Idempotent: re-running
 * with the same slug overwrites that slug's block but does not duplicate.
 */
export function registerConnector(scope, slug, entry) {
  const file = path.join(scope, ".connectors", "config.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let parsed = { connectors: {} };
  if (fs.existsSync(file)) {
    try {
      parsed = yaml.load(fs.readFileSync(file, "utf-8")) ?? {};
    } catch {
      parsed = {};
    }
    if (!parsed.connectors || typeof parsed.connectors !== "object") {
      parsed.connectors = {};
    }
  }

  parsed.connectors[slug] = {
    ...entry,
    enabled: true,
  };

  fs.writeFileSync(file, yaml.dump(parsed, { lineWidth: 120 }));
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugins/connector-creator/connector-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/lib/connector-registry.mjs tests/plugins/connector-creator/connector-registry.test.ts
git commit -m "feat(create-connector): config.yaml registration helper"
```

---

## Task 14: Flavor templates — shell-gate

Stamps a connector that has only `gates.json` + `SKILL.md`. Most useful for the "approve before X runs" use case.

**Files:**
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/shell-gate/gates.json.tmpl`
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/shell-gate/SKILL.md.tmpl`

- [ ] **Step 1: Create `gates.json.tmpl`**

```
{
  "rules": [
{{RULES}}
  ]
}
```

The skill substitutes `{{RULES}}` with one or more rule objects:

```
    {
      "name": "{{RULE_NAME}}",
      "decision": "{{DECISION}}",
      "reason": "{{REASON}}",
      "pattern": "{{PATTERN}}"
    }
```

- [ ] **Step 2: Create `SKILL.md.tmpl`**

```markdown
---
name: {{SLUG}}
description: |
  {{DESCRIPTION}}
context: connector
---

# {{ServicePascal}}

Shell-command gate. {{DESCRIPTION}}

## What it does

When Claude Code is about to invoke a Bash command matching one of the
patterns below, this connector intercepts and surfaces a permission
decision. No actions are exposed; this connector is purely a gate.

## Rules

| Pattern | Decision | Reason |
|---|---|---|
{{RULES_TABLE}}

## Disable

Set `NARAI_GATE_DISABLE` to a comma-separated list of rule names to skip
specific rules without uninstalling.
```

- [ ] **Step 3: Add a smoke test for the template content**

```ts
// tests/plugins/connector-creator/templates.test.ts
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
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/plugins/connector-creator/templates.test.ts`
Expected: PASS, 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/assets/templates/shell-gate/ tests/plugins/connector-creator/templates.test.ts
git commit -m "feat(create-connector): shell-gate flavor templates"
```

---

## Task 15: Flavor templates — composite + knowledge

Add the remaining two templates so the skill has all five flavors covered (api-wrapper already exists; custom uses no template).

**Files:**
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/composite/index.mjs.tmpl`
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/composite/bin.tmpl`
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/composite/SKILL.md.tmpl`
- Create: `plugins/connector-creator/skills/create-connector/assets/templates/knowledge/SKILL.md.tmpl`

- [ ] **Step 1: Create `composite/index.mjs.tmpl`**

```js
// {{SLUG}} — composite orchestrator. Calls {{DEPENDENCIES}} and composes the result.
import { gather } from "narai-primitives";

const SLUG = "{{SLUG}}";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action) return errorEnvelope("VALIDATION_ERROR", "missing --action");

  switch (args.action) {
{{ACTIONS_DICTIONARY}}
    default:
      return errorEnvelope("VALIDATION_ERROR", `unknown action ${args.action}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--action") out.action = argv[++i];
    if (argv[i] === "--params") out.params = JSON.parse(argv[++i]);
  }
  return out;
}

function errorEnvelope(code, message) {
  process.stdout.write(JSON.stringify({
    status: "error",
    error_code: code,
    message,
  }) + "\n");
  process.exit(1);
}

main().catch((err) => errorEnvelope("INTERNAL_ERROR", err?.message ?? String(err)));
```

- [ ] **Step 2: Create `composite/bin.tmpl`**

```sh
#!/bin/sh
exec node "$(dirname "$0")/../index.mjs" "$@"
```

- [ ] **Step 3: Create `composite/SKILL.md.tmpl`**

```markdown
---
name: {{SLUG}}
description: |
  {{DESCRIPTION}}
context: connector
---

# {{ServicePascal}}

Composite orchestrator. {{DESCRIPTION}}

## Calls

This connector calls these other connectors via `gather()`:

{{DEPENDENCIES_TABLE}}

## Actions

{{ACTIONS_TABLE_MD}}

## Invocation

```sh
{{SLUG}} --action {{FIRST_ACTION}} --params '{...}'
```
```

- [ ] **Step 4: Create `knowledge/SKILL.md.tmpl`**

```markdown
---
name: {{SLUG}}
description: |
  {{DESCRIPTION}}
context: connector
---

# {{ServicePascal}}

Knowledge-only connector — no executable code. The model uses this SKILL.md
as a runbook for {{DESCRIPTION_SHORT}}.

## When to use

{{USE_CASES}}

## Steps

{{STEPS}}

## Caveats

{{CAVEATS}}
```

- [ ] **Step 5: Add tests for new templates**

Append to `tests/plugins/connector-creator/templates.test.ts`:

```ts
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
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/plugins/connector-creator/templates.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/assets/templates/composite/ plugins/connector-creator/skills/create-connector/assets/templates/knowledge/ tests/plugins/connector-creator/templates.test.ts
git commit -m "feat(create-connector): composite + knowledge flavor templates"
```

---

## Task 16: Adaptive flow — rewrite `SKILL.md`

Rewrite `plugins/connector-creator/skills/create-connector/SKILL.md` to use the adaptive flow with 5 flavors. Heavy editorial change; structure follows the spec's "Skill flow" section.

**Files:**
- Modify: `plugins/connector-creator/skills/create-connector/SKILL.md`

- [ ] **Step 1: Read the current SKILL.md to understand what's preserved vs rewritten**

```sh
cat plugins/connector-creator/skills/create-connector/SKILL.md
```

Note: the existing 7-step interview becomes the API/SDK wrapper flavor's checklist. Most of the existing content stays, just under a flavor heading.

- [ ] **Step 2: Rewrite the SKILL.md with adaptive flow + flavor sections**

Replace the SKILL.md body with these sections (preserve the existing frontmatter):

1. **Adaptive flow overview** — 7-step open flow (open / identify shape / research / shape-questions / confirm / stamp / verify).
2. **Flavor recognition cues** — table of trigger phrasings → flavor.
3. **API/SDK wrapper flavor** — the existing 7-step checklist, lifted from current SKILL.md.
4. **Shell-gate flavor** — checklist for "what command(s)? what decision? why?".
5. **Composite flavor** — checklist for "which existing connectors? what's the goal?".
6. **Knowledge-only flavor** — checklist for "what workflow? when to use?".
7. **Custom flavor** — guidance for code-gen against the connector contract.
8. **First-run wiring** — describe stamping `connector-gate.mjs` + settings.json hook.
9. **Reference** — link to `references/connector-contract.md`, `references/flavor-authoring.md`, `references/research-patterns.md`.

The full rewrite is too large to inline here verbatim; the implementer should copy the existing SKILL.md as a starting point and reorganize sections. Key invariants: keep the policy-gate-is-automatic note; keep the auth-patterns / action-design / db-redirect references; add the new flavor sections.

Make sure the rewritten SKILL.md:
- Mentions `_runtime/connector-gate.mjs.tmpl` is stamped on first run if any connector has `gates.json`.
- Documents the `lib/settings-wiring.mjs` and `lib/connector-registry.mjs` helpers.
- Lists all 5 flavors with their trigger phrasings.

- [ ] **Step 3: Verify the SKILL.md still parses (frontmatter)**

```sh
head -20 plugins/connector-creator/skills/create-connector/SKILL.md
```

Expected: frontmatter with `name`, `description`, valid YAML.

- [ ] **Step 4: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/SKILL.md
git commit -m "feat(create-connector): adaptive flow + 5 flavor recipes in SKILL.md"
```

---

## Task 17: Reference docs

Three reference files reused by the skill: connector contract, flavor authoring guide, research patterns.

**Files:**
- Create: `plugins/connector-creator/skills/create-connector/references/connector-contract.md`
- Create: `plugins/connector-creator/skills/create-connector/references/flavor-authoring.md`
- Create: `plugins/connector-creator/skills/create-connector/references/research-patterns.md`

- [ ] **Step 1: Create `connector-contract.md`**

Content: spec section "Connector contract" rewritten as a developer reference. Required: SKILL.md + config.yaml entry. Optional: index.mjs / gates.json / bin / nothing. Decision precedence. File-tree example. ~80 lines.

- [ ] **Step 2: Create `flavor-authoring.md`**

Content: how to add a new flavor. Template directory layout. Placeholder substitution conventions. Where to register the flavor in SKILL.md. ~50 lines.

- [ ] **Step 3: Create `research-patterns.md`**

Content: when to WebFetch vs WebSearch vs context7 vs grep-existing-connectors. Examples of triggering phrases. ~50 lines.

- [ ] **Step 4: Verify the references exist**

```sh
ls plugins/connector-creator/skills/create-connector/references/
```

Expected: shows the three new files plus the existing auth-patterns.md, action-design.md, db-agent-pointer.md.

- [ ] **Step 5: Commit**

```sh
git add plugins/connector-creator/skills/create-connector/references/
git commit -m "docs(create-connector): connector-contract + flavor-authoring + research-patterns references"
```

---

## Task 18: End-to-end skill test

Tests for the full create-connector flow: stamp a connector, register in config.yaml, wire settings.json, smoke-test the gate. Uses the helpers from Tasks 11-13 against synthetic fixtures.

**Files:**
- Create: `tests/plugins/connector-creator/skill-end-to-end.test.ts`

- [ ] **Step 1: Write the end-to-end test**

```ts
// tests/plugins/connector-creator/skill-end-to-end.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSettingsHook } from "../../../plugins/connector-creator/skills/create-connector/lib/settings-wiring.mjs";
import { registerConnector } from "../../../plugins/connector-creator/skills/create-connector/lib/connector-registry.mjs";

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

describe("create-connector end-to-end (shell-gate flavor)", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("stamps a working shell-gate connector end-to-end", async () => {
    // 1. Stamp connector-gate.mjs from template.
    const runtimeSrc = fs.readFileSync(
      path.join(TEMPLATES, "_runtime", "connector-gate.mjs.tmpl"),
      "utf-8",
    );
    const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
    fs.mkdirSync(path.dirname(gatePath), { recursive: true });
    fs.writeFileSync(gatePath, runtimeSrc);

    // 2. Stamp the shell-gate connector files.
    const slug = "deploy-prod";
    const dir = path.join(scope, ".connectors", "connectors", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gates.json"),
      JSON.stringify({
        rules: [
          {
            name: "deny_prod_kubectl",
            decision: "deny",
            reason: "no direct prod kubectl",
            pattern: "^kubectl\\s+.*\\bprod\\b",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: deploy-prod\ndescription: gate prod kubectl\ncontext: connector\n---\n",
    );

    // 3. Register in config.yaml.
    registerConnector(scope, slug, {
      skill: dir,
      bin: null,
    });

    // 4. Wire settings.json.
    const settingsPath = path.join(scope, ".claude", "settings.json");
    ensureSettingsHook(settingsPath, gatePath);

    // 5. Smoke-test the gate by spawning it directly.
    const r = await new Promise<{stdout: string, exitCode: number}>((resolve) => {
      const proc = spawn("node", [gatePath], {
        env: { ...process.env, NARAI_GATE_SCOPE: scope },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.on("close", (code) => resolve({ stdout, exitCode: code ?? -1 }));
      proc.stdin.write(JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "kubectl get pods -n prod" },
      }));
      proc.stdin.end();
    });

    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/prod/);

    // 6. Verify settings.json wires the gate.
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain(gatePath);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/plugins/connector-creator/skill-end-to-end.test.ts`
Expected: PASS, 1 test passes.

- [ ] **Step 3: Run full suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```sh
git add tests/plugins/connector-creator/skill-end-to-end.test.ts
git commit -m "test(create-connector): end-to-end shell-gate flavor smoke test"
```

---

## Verification (after all tasks)

Run the full suite and verify:

```sh
npx tsc --noEmit
npx vitest run
```

Both must be clean. The full suite should grow by ~30 tests (Phase A: ~12, Phase B: ~15+).

Manual smoke test against a real Claude Code install:

1. Install one of the migrated builtin plugins (e.g. `aws-agent`) via the marketplace.
2. Start a Claude Code session; observe SessionStart hooks fire (reminder banner if applicable).
3. Run a Bash command; observe usage-record event in `~/.usage/aws.jsonl`.
4. End the session; observe session-summary.

Manual create-connector smoke test:

1. Invoke `/create-connector` for a shell-gate scenario ("gate kubectl delete").
2. Walk through the flow.
3. Verify `.connectors/connectors/<slug>/gates.json` is stamped.
4. Verify `.claude/settings.json` is created/updated with the gate hook.
5. Run a matching command; observe the deny prompt.

---

## Self-review notes

- All Phase A tasks have failing tests written first, then implementation, then commit. ✓
- Each task names exact file paths. ✓
- Migration tasks for builtin plugins (Tasks 8, 9, 10) include the smoke-test step before commit. ✓
- Type/method consistency: `parsePluginConfig`, `findSiblingInstall`, `ensureSettingsHook`, `hasConnectorGateHook`, `registerConnector` are all introduced and used consistently. ✓
- No "TBD" / "fill in details" — every code step has full inline code. ✓
- The single content gap is Task 16's SKILL.md rewrite, where the editorial scope is too large to inline verbatim. The task names every section that must be present and what each must contain. ✓
- Linear-agent migration is intentionally out of scope per the spec. ✓
