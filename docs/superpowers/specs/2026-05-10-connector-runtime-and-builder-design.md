# Connector runtime + interactive builder

**Date**: 2026-05-10
**Branch**: `feat/connector-runtime`
**Status**: design

## Context

Two unrelated problems share a fix:

1. **Builtin plugin duplication**. The 7 narai-primitives Claude Code plugins (`aws-agent`, `confluence-agent`, `db-agent`, `gcp-agent`, `github-agent`, `jira-agent`, `notion-agent`) ship near-identical `hooks/hooks.json` (~49 lines each, total ~343) and per-plugin `reminder.mjs` (~16 lines each, total ~110). Across 7 plugins that's ~460 lines of near-duplicate config plus an N-fold `npm install narai-primitives` per Claude Code session.

2. **Users can't easily add a connector for their internal stuff**. Today's `create-connector` skill is a fixed 7-step interview that only stamps API/SDK wrappers via `createConnector`. It doesn't help when the user wants to gate a shell command, compose existing connectors, or scaffold a knowledge-only workflow. And gating shell commands today requires building a Claude Code plugin (like the existing `git-plugin`) — overkill for a per-project rule.

The two are connected: a flexible builder needs a runtime to plug into, and the runtime that can pick up user-defined gates is exactly the kind of thing the cleanup wants anyway. Solving them together gives one mental model — "a connector is anything at `.connectors/connectors/<slug>/`" — instead of two parallel concepts (builtin plugins, hand-rolled hooks).

## Goals

- Cut the ~460 lines of duplicated hook config across builtin plugins to a single shared dispatcher.
- Smart-bootstrap `narai-primitives` once per Claude Code session, not N times.
- Let users create gates without packaging a Claude Code plugin (settings.json hook, or a builtin's runtime auto-discovers them).
- Upgrade `create-connector` to be research-capable, adaptive, and flavor-aware. The user describes their need in their own words; the LLM picks the right shape.
- Define a thin **connector contract** the runtime and the skill share.

## Non-goals

- Backwards-incompatible changes to existing user connectors created with today's `create-connector` (API wrappers continue to work as-is).
- New marketplace flow or npm publishing changes.
- Replacing the Claude Code plugin model — the 7 builtin plugins stay as plugins, since they ship via the marketplace and need `npm install narai-primitives`.
- Renaming `git-plugin` (it is a real Claude Code plugin and naming reflects that).

## Architecture

```
narai-primitives repo
└── plugin-hooks/
    └── dispatcher.mjs          ← single shared script, used by builtin plugins
        ├── session-start       (npm install + reminder + stale-summarize)
        ├── pre-tool-use        (db-guard + .connectors/ gates)
        ├── post-tool-use       (usage-record)
        └── session-end         (session-summary)

User's project (or $HOME)
├── .claude/settings.json       ← hook entry pointing at connector-gate.mjs (created on first /create-connector)
└── .connectors/
    ├── config.yaml             ← connector registry
    ├── connector-gate.mjs      ← standalone dispatcher (zero-dep, stamped on first run)
    └── connectors/
        ├── stripe/             ← API/SDK wrapper
        ├── deploy-prod/        ← shell-gate
        ├── linear-summary/     ← composite orchestrator
        └── runbook-ssh/        ← knowledge-only
```

Two dispatcher implementations, related but not identical:

- **`plugin-hooks/dispatcher.mjs`** (in narai-primitives) — bundled with the package; can import from `narai-primitives/toolkit`. Used by builtin Claude Code plugins.
- **`connector-gate.mjs`** (in user's `.connectors/`) — standalone, zero-dep. Stamped by the skill the first time a gate-bearing connector is created. Reads `.connectors/connectors/*/gates.json` and applies decisions.

Both can read user connectors. If the user has any builtin plugin installed, the in-package dispatcher picks up the user's gates too — defense in depth, with `deny` precedence keeping decisions consistent across firings.

## Connector contract

A connector is a directory at `<scope>/.connectors/connectors/<slug>/` that satisfies:

- **`SKILL.md`** (required) — model-facing description: what the connector does, when to invoke it, what params/inputs are expected.
- **Entry in `<scope>/.connectors/config.yaml`** under `connectors:` — slug, absolute paths to skill and (optional) bin, `enabled: true`.

Plus optionally any combination of:

- **`index.mjs`** — programmatic actions, built with `createConnector` from `narai-primitives/toolkit`. Gives you the toolkit's policy gate, classification, audit, hardship logging for free. Invoked via `gather()` or directly via the bin shim.
- **`gates.json`** — declarative shell-command gates. JSON shape:
  ```json
  {
    "rules": [
      { "name": "deny_prod_delete", "decision": "deny", "reason": "...",
        "pattern": "^kubectl\\s+delete\\s+.*\\b(prod|production)\\b" }
    ]
  }
  ```
  The dispatcher reads `gates.json` from every connector in `.connectors/connectors/*/`, applies each rule's regex against the bash command, and emits a `permissionDecision` for the strictest match.
- **`bin/<slug>`** — CLI shim that execs `index.mjs`. Required if `index.mjs` is present and the connector should be reachable from the shell.
- **(nothing else)** — knowledge-only connector: just SKILL.md + config.yaml entry. The model uses the SKILL.md as a runbook; no code runs.

The runtime treats unknown files as opaque. The skill is free to add files specific to a flavor (e.g., template configs, lookup tables) without changing the contract.

## Connector flavors (v1)

The skill recognizes four canonical shapes from the user's description, plus a fallback for novel cases.

| Flavor | Trigger phrasing | Files generated |
|---|---|---|
| **API/SDK wrapper** | "wrap our X API", "connect to Y SaaS" | `index.mjs`, `bin/<slug>`, `SKILL.md` |
| **Shell-command gate** | "gate `cmd`", "approve before X runs", "deny Y in prod" | `gates.json`, `SKILL.md` |
| **Composite orchestrator** | "pull A, summarize, post to B"; multi-step workflows | `index.mjs` (uses `gather()` on existing connectors, may include LLM-summary calls), `bin/<slug>`, `SKILL.md` |
| **Knowledge-only** | "document this workflow"; runbooks | `SKILL.md` only |
| **Custom** | anything that doesn't fit above | LLM does pure code-gen against the contract |

Each flavor has its own template directory (`assets/templates/<flavor>/`) and its own checklist of shape-specific questions. The skill is *not* a fixed form — it identifies the flavor from the user's words, asks only the relevant questions, and falls back to code-gen for novel cases.

## Track A — Repo cleanup

### Shared dispatcher (`narai-primitives/plugin-hooks/dispatcher.mjs`)

ESM script. Receives the event name as the first argv argument:

```sh
node plugin-hooks/dispatcher.mjs session-start
node plugin-hooks/dispatcher.mjs pre-tool-use
node plugin-hooks/dispatcher.mjs post-tool-use
node plugin-hooks/dispatcher.mjs session-end
```

Reads `${CLAUDE_PLUGIN_ROOT}/plugin-config.json` for plugin identity:

```json
{
  "name": "jira",
  "binPath": "narai-primitives/dist/connectors/jira",
  "kind": "connector"
}
```

Routes by event:

- **`session-start`** — bootstrap (smart install), then `evaluateNudge` (replaces per-plugin `reminder.mjs`), then `stale-summarize`.
- **`pre-tool-use`** — db-agent guardrail (only if `kind === "db"`); user `.connectors/` gate scan; emit decision per merged precedence.
- **`post-tool-use`** — `usage-record`.
- **`session-end`** — `session-summary`.

**Smart bootstrap**: dispatcher reads `${CLAUDE_PLUGIN_DATA}/../*/node_modules/narai-primitives/package.json` (sibling plugins' data dirs), checks if any has the same version. If yes, the current plugin's `node_modules` is symlinked to (or copied from) the sibling — skipping `npm install`. If none, install normally. Falls back gracefully if the layout doesn't permit sibling discovery.

### Per-plugin `hooks.json` (after migration)

Reduced to event-routing thin wrappers:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" session-start"
      }]}
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" post-tool-use"
      }]}
    ],
    "SessionEnd": [
      { "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/plugin-hooks/dispatcher.mjs\" session-end"
      }]}
    ]
  }
}
```

For `db-agent`, an additional `PreToolUse` entry pointing the dispatcher at `pre-tool-use` (which delegates internally to the existing db-guard logic).

Net per-plugin change: ~49 lines → ~24 lines, with the actual work moving into the shared dispatcher.

### Files added/removed

**Added**:
- `plugin-hooks/dispatcher.mjs` (~250 LOC, replacing distributed bits)
- `plugins/<x>/plugin-config.json` (×7, ~5 lines each)

**Removed**:
- `plugins/<x>/hooks/reminder.mjs` (×7)
- The bulk of `plugins/<x>/hooks/hooks.json` (×7) — kept thin

## Track B — User-side runtime + skill upgrade

### Standalone dispatcher (`<scope>/.connectors/connector-gate.mjs`)

Self-contained ESM. Zero npm dependencies. Stamped by the skill on first use of a gate-bearing connector.

Behavior:

1. Read stdin (Claude Code PreToolUse payload).
2. If `tool_name !== "Bash"` → emit no decision (exit 0).
3. Walk `<scope>/.connectors/connectors/*/gates.json`. For each rule, test its `pattern` regex against the command (after splitting on `&&`/`||`/`;`/`|` and stripping env prefixes — same as `git-plugin/hooks/rules.mjs`).
4. Decision precedence: `deny > ask > allow`. Emit the strictest match.

Same shape as `plugins/git-plugin/hooks/git_gate.mjs` + `rules.mjs`, generalized to read rules from disk instead of having them hardcoded.

### Settings.json wiring

The skill writes one `PreToolUse` hook entry to:

- **Project scope** → `<project>/.claude/settings.json`
- **User scope** → `~/.claude/settings.json`

Entry:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "node <abs-path>/.connectors/connector-gate.mjs"
        }]
      }
    ]
  }
}
```

**Idempotency rules**:

- If `settings.json` doesn't exist → create with just this hook entry.
- If it exists with no overlapping entry → merge in the new hook (preserve everything else).
- If it exists with an entry already pointing at our `connector-gate.mjs` → no-op.
- If it exists with a conflicting `PreToolUse` Bash entry → ask the user before merging; show the diff.
- Always back up `settings.json` to `settings.json.bak-<timestamp>` before writing.

### `create-connector` skill upgrade

#### Adaptive flow

Replace the rigid 7-step interview with:

1. **Open**: *"Tell me about what you want to build."* (Freeform.)
2. **Identify shape**: 1-3 follow-ups based on the user's first answer. Listen for cues — service name, command, "I want to gate", "summarize", "pull X then post Y".
3. **Research if needed**: For unfamiliar services, WebFetch the service's API docs. WebSearch if no URL is obvious. context7 for libraries the user mentions. Reference existing builtin connectors (`src/connectors/<x>`) when they're a structural match.
4. **Shape-specific questions**: Each flavor has its own checklist. The skill asks only what's relevant for the recognized shape. For "custom" flavor, the skill explores the design with the user before generating code.
5. **Confirm summary**: Show the file tree that will be created, the registry entry, and (if first time) the settings.json change. Wait for explicit OK.
6. **Stamp**: Write files. Append to `config.yaml`. (First time) install settings.json hook + dispatcher.
7. **Verify**: Smoke-test the bin shim or hook script. Report success or troubleshoot.

#### Flavor templates

Located at `plugins/create-connector/skills/create-connector/assets/templates/<flavor>/`:

- `api-wrapper/` — `index.mjs.tmpl`, `bin.tmpl`, `SKILL.md.tmpl` (today's templates, lightly refactored)
- `shell-gate/` — `gates.json.tmpl`, `SKILL.md.tmpl`
- `composite/` — `index.mjs.tmpl` (uses `gather`), `bin.tmpl`, `SKILL.md.tmpl`
- `knowledge/` — `SKILL.md.tmpl` only
- `_runtime/` — `connector-gate.mjs.tmpl` (the dispatcher itself, stamped on first run)

For "custom" flavor, no template — pure LLM code-gen with the connector contract as the constraint.

#### Research integration

Documented in `references/research-patterns.md`:

- **Service unknown** → WebFetch on `<service>.com/docs/api` (or whatever URL the user provides). Fall back to WebSearch.
- **Library mentioned** → context7 for current docs.
- **"Like our jira connector"** → read `src/connectors/jira/index.ts` as a structural reference.
- **Always confirm** — research findings inform the questions asked; the skill never decides architectural shape unilaterally based on research.

## Migration of `git-plugin`

`git-plugin` stays as a Claude Code plugin (`plugins/git-plugin/`). It's a useful real-world example of:

- A hook-only plugin (no actions, no connector)
- A self-contained gate dispatcher (its `git_gate.mjs` is 90% of `connector-gate.mjs`)
- The same pattern users will write for shell-gate connectors

Its `git_gate.mjs` and `rules.mjs` are factored as the canonical example for the shell-gate flavor template. The skill's `shell-gate/SKILL.md.tmpl` and template structure mirror git-plugin's layout, just data-driven from `gates.json`.

## Edge cases

- **Settings.json doesn't exist**: skill creates it with minimal valid content + the hook entry.
- **Settings.json has malformed JSON**: skill refuses to overwrite; surfaces the parse error to the user; halts the create-connector flow.
- **Multiple scopes**: a project-level `.connectors/` and a user-level `~/.connectors/` can coexist. The standalone dispatcher reads both; project rules win on tied-strictness via order.
- **Sibling plugin discovery fails** (Track A): smart bootstrap falls back to a normal `npm install`. No worse than today.
- **Composite orchestration depends on uninstalled connectors**: the skill flags this in the summary ("requires `linear-agent` and `slack-agent`"); generation proceeds; runtime errors surface clearly when the dependency is missing.
- **User has both a builtin plugin and a settings.json hook**: both runtimes fire. Decisions are consistent (deny precedence), so there's no double-trouble for the user — the strictest decision wins regardless of which path emitted it.

## Tests

### Track A
- **Unit**: dispatcher event routing (each event invokes the right internal handler).
- **Unit**: `plugin-config.json` parsing + validation.
- **Integration**: spawn dispatcher with synthetic Claude Code hook payload via stdin; assert correct stdout shape per event.
- **Smart bootstrap**: mock filesystem with a sibling plugin's `node_modules`; assert install is skipped.
- **Per-plugin smoke**: each migrated plugin's `hooks.json` invokes the dispatcher with the right event.

### Track B
- **Unit**: `connector-gate.mjs` rule loading from disk; decision precedence; segment splitting (covered by porting tests from `git-plugin/rules.test.ts`).
- **Unit**: settings.json wiring is idempotent (first run creates, subsequent runs no-op).
- **Unit**: settings.json conflict detection (synthetic existing entries).
- **Integration**: end-to-end skill invocation — `/create-connector` for each flavor; assert file tree, config.yaml entry, settings.json updates, smoke-test passes.
- **Edge**: malformed config.yaml or gates.json doesn't crash the dispatcher.

### Existing test surface
- Existing `tests/plugins/git-plugin/rules.test.ts` and `plugins/git-plugin/tests/smoke.test.ts` continue to pass — git-plugin's logic is the canonical reference.
- Existing connector tests for builtin plugins continue to pass — no behavior change at the action layer.

## Sequencing (one PR, multiple commits)

1. `feat(plugin-hooks): shared dispatcher.mjs + plugin-config.json contract` — adds the dispatcher; no plugin migration yet.
2. `feat(builtin-plugins): migrate aws/confluence/gcp/github/jira/notion to dispatcher` — six plugins, mechanical change.
3. `feat(db-agent): migrate to dispatcher (preserves db-guard PreToolUse)` — special case kept separate for review.
4. `feat(connectors): standalone connector-gate.mjs + connector contract reference doc`
5. `feat(create-connector): adaptive flow + flavor recipes (api-wrapper, shell-gate, composite, knowledge, custom)`
6. `feat(create-connector): settings.json wiring + first-run stamp of connector-gate.mjs`
7. `test: dispatcher + connector-gate + skill end-to-end coverage`
8. `docs: connector contract reference + flavor authoring guide`

Each commit type-checks, tests pass, and is independently reviewable. Commits 1-3 are repo cleanup (Track A); 4-8 are user-facing capability (Track B). Commit 4 introduces the standalone dispatcher in advance of the skill changes so the skill has something to wire against.

Linear-agent migration is *not* in this PR — it waits for #17 to merge first, then a follow-up commit lands it.

## Critical files

**To create**:
- `plugin-hooks/dispatcher.mjs` (Track A core)
- `plugins/<x>/plugin-config.json` (×7)
- `plugins/create-connector/skills/create-connector/assets/templates/_runtime/connector-gate.mjs.tmpl`
- `plugins/create-connector/skills/create-connector/assets/templates/{api-wrapper,shell-gate,composite,knowledge}/...`
- `plugins/create-connector/skills/create-connector/references/research-patterns.md`
- `docs/connector-contract.md` (reference doc)
- `tests/plugin-hooks/dispatcher.test.ts`
- `tests/connectors/runtime/connector-gate.test.ts`
- `tests/skills/create-connector/end-to-end.test.ts`

**To modify**:
- `plugins/<x>/hooks/hooks.json` (×7) — replaced with thin event-routing
- `plugins/create-connector/skills/create-connector/SKILL.md` — adaptive flow rewrite
- `plugins/create-connector/skills/create-connector/references/auth-patterns.md` — preserved as-is
- `plugins/create-connector/skills/create-connector/references/action-design.md` — preserved as-is

**To delete**:
- `plugins/<x>/hooks/reminder.mjs` (×7)

**To reuse**:
- `plugins/git-plugin/hooks/rules.mjs` and `git_gate.mjs` — structural template for `connector-gate.mjs`
- `plugins/git-plugin/tests/smoke.test.ts` — pattern for the new dispatcher's smoke tests
- `src/toolkit/plugin/reminder.ts` (`evaluateNudge`) — imported by the dispatcher via the `narai-primitives/toolkit` package export
- `plugin-hooks/{usage-record,session-summary,stale-summarize}.mjs` — already shared scripts at the package root; dispatcher delegates to them by `await import`-ing their relative path

## Verification

After merge:

1. **Repo size**: confirm ~460 lines of duplicated config removed.
2. **Cold-session install time**: measure with all 7 builtin plugins installed; confirm only one `npm install` runs.
3. **End-to-end**: install `jira-agent` plugin in Claude Code, confirm hooks still fire (reminder, usage-record, etc.).
4. **End-to-end**: invoke `/create-connector`, walk through each of the 5 flavors against synthetic services; confirm each produces a working connector and settings.json (where applicable) is set up correctly.
5. **Existing connectors**: verify a connector created by today's `create-connector` continues to work after the skill upgrade (no migration breakage).

## What we don't do in v1

- Linear-agent migration (waits for PR #17 to merge).
- npm-published version of `connector-gate.mjs` (it's a stamped artifact in user's repo, not a dependency).
- Live Claude Code plugin marketplace integration changes.
- Renaming `git-plugin` (it's a Claude Code plugin, naming reflects that).
- Multi-language connectors (only Node ESM in v1; Python/Bash hooks are out of scope).
- Connector versioning / upgrade flow (out of scope; users edit files directly).
