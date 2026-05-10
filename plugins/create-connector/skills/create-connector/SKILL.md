---
name: create-connector
description: |
  Use this skill when the user wants to add a custom connector to their project —
  wrapping a SaaS API, REST endpoint, GraphQL endpoint, SDK, or CLI tool so
  Claude can call it via `gather()` from `narai-primitives`. Trigger even when
  the user doesn't say "connector" explicitly: phrases like "I want to query
  Stripe from Claude", "add Slack to our agents", "wrap our internal orders
  API", "connect Salesforce", "make a Linear agent" all warrant this skill.
  Also triggers for: "gate kubectl in prod", "approve before force push",
  "pull from Linear, summarize, post to Slack", "document this workflow".
  Scaffolds a minimal local connector at `.connectors/connectors/<name>/`
  (project scope, default) or `~/.connectors/connectors/<name>/` (user scope) —
  no `git init`, no `npm publish`, no plugin manifest, no marketplace entry.
  Do NOT use for: modifying an existing connector (just edit the file),
  wrapping an MCP server (different abstraction), querying databases (the `db`
  connector inside narai-primitives already covers postgres/mysql/sqlite/mssql/
  mongodb/dynamodb/oracle), or contributing a new builtin connector (that's a
  PR to https://github.com/narailabs/narai-primitives — see its CONTRIBUTING.md).
---

# create-connector

Scaffold a custom connector that the user's local installation loads via `narai-primitives`'s `gather()`. The connector is **local-only**: it does not get published to npm, does not become a Claude Code plugin, and does not go in any marketplace. The user can later send a PR to `narailabs/narai-primitives` if their connector turns out to be broadly useful — that's a separate flow.

This skill is **not a fixed form**. It recognizes five distinct connector shapes (flavors) from the user's words, asks only the questions that matter for the recognized shape, and falls back to freeform code-gen for novel cases. For unknown services it researches docs before asking questions.

## When to invoke

Use this skill when the user wants to **create a new custom connector** for local use.

Classic phrasings:
- "I want to wrap the Stripe API"
- "Make me a Slack connector"
- "We need a connector for our internal orders API"
- "Add Linear to our agents"

Near-miss phrasings (still trigger):
- "I want to query Stripe from Claude"
- "Connect Salesforce to Claude Code"
- "Make a thing that lets me search Jira from Claude"

Also triggers for the new flavors:
- "Gate `kubectl` in prod" / "Deny force push" / "Approve before deploy runs" → Shell-command gate
- "Pull from Linear, summarize, post to Slack" / "Multi-step workflow" → Composite orchestrator
- "Document this runbook" / "Capture this workflow as a skill" → Knowledge-only

**Do NOT use this skill for:**

- **Modifying an existing connector.** Just edit the file directly.
- **Wrapping an MCP server.** MCP servers and connectors are different abstractions in Claude Code. Point the user at the Claude Code MCP docs.
- **Querying a database.** `narai-primitives/db` covers postgres, mysql, sqlite, mssql, mongodb, dynamodb, oracle. See `references/db-agent-pointer.md`. Only suggest a custom DB connector if it's a backend the bundled `db` connector doesn't support.
- **Contributing a builtin connector to `narai-primitives`.** That's a different flow (PR to the bundle's repo, separate test suite, plugin marketplace entry). This skill is for end-user local connectors only.

## What gets created

Files vary by flavor. Examples for each:

**API/SDK wrapper** (`stripe`):
```
<scope>/.connectors/connectors/stripe/
├── SKILL.md
├── index.mjs
└── bin/stripe
```

**Shell-command gate** (`prod-kubectl`):
```
<scope>/.connectors/connectors/prod-kubectl/
├── SKILL.md
└── gates.json
```
Plus first-run wiring (once per scope):
```
<scope>/.connectors/connector-gate.mjs   ← stamped from _runtime template
<scope>/.claude/settings.json            ← PreToolUse hook entry added
```

**Composite orchestrator** (`linear-to-slack`):
```
<scope>/.connectors/connectors/linear-to-slack/
├── SKILL.md
├── index.mjs
└── bin/linear-to-slack
```

**Knowledge-only** (`deploy-runbook`):
```
<scope>/.connectors/connectors/deploy-runbook/
└── SKILL.md
```

**Custom** (whatever files are needed — code-gen guided by the connector contract).

Plus one entry appended to `<scope>/.connectors/config.yaml` in all cases:

```yaml
connectors:
  <slug>:
    skill: <abs-path-to-connector-dir>
    bin:   <abs-path-to-bin>          # null for shell-gate, knowledge-only
    enabled: true
```

## Adaptive flow

The skill runs a 7-step flow. Steps 1-2 identify the shape; steps 3-4 do the research and ask shape-specific questions; steps 5-7 confirm, stamp, and verify.

1. **Open** — Ask: *"Tell me about what you want to build."* Freeform. Do not offer a menu.
2. **Identify shape** — Listen for cues (see "Flavor recognition cues" below). Ask 1-3 clarifying questions if the shape is ambiguous. Pick a flavor. State your pick explicitly: *"This sounds like a shell-command gate. Is that right?"*
3. **Research** — For unknown services, use WebFetch / WebSearch / context7. See `references/research-patterns.md`. Research findings inform questions asked; never decide architectural shape unilaterally based on research alone.
4. **Shape-specific questions** — Each flavor has its own checklist (sections below). Ask only the checklist that matches the shape.
5. **Confirm summary** — Show the file tree that will be created, the registry entry, and (if first run) the settings.json change. Wait for explicit OK before writing anything.
6. **Stamp** — Write template files; substitute placeholders; register in `config.yaml`; (first time for gate-bearing connectors) install `settings.json` hook and stamp `connector-gate.mjs`.
7. **Verify** — Smoke-test the bin shim or hook script. Report success or troubleshoot.

## Flavor recognition cues

| Cue | Flavor |
|---|---|
| "wrap our X API", "connect to Y SaaS", "query X from Claude" | API/SDK wrapper |
| "gate `cmd`", "approve before X runs", "deny Y in prod", "block force push" | Shell-command gate |
| "pull A, summarize, post to B"; multi-step workflows using existing connectors | Composite orchestrator |
| "document this workflow", "capture this runbook", "make a skill for our deploy process" | Knowledge-only |
| anything that doesn't fit the above | Custom (pure code-gen) |

## Flavor: API / SDK wrapper

Today's default behavior. Use when the user wants to call a SaaS or REST/GraphQL API.

### Step 1 — Scope

Ask: *"Should this connector be available only in this project, or for all your projects?"*

| Choice | Where it lives | Default for |
|---|---|---|
| **Project (default)** | `./.connectors/connectors/<slug>/` | repo-specific stuff |
| **User** | `~/.connectors/connectors/<slug>/` | personal tools |

Pick a sensible default based on the user's phrasing. The scope determines which `config.yaml` gets the entry.

### Step 2 — Identity

Ask: *"What's the service slug?"*

- **Slug**: lowercase, alphanumeric + hyphens (e.g., `stripe`, `slack`, `acme-orders`). Used everywhere.
- **Description**: one sentence (e.g., "Read-only Stripe connector: customers, charges, invoices.")

### Step 3 — Auth

Ask: *"How does authentication work for this API?"*

Map the answer to one of:

- **`bearer-token-env-var`** (default) — single env var like `STRIPE_API_KEY`, used as `Authorization: Bearer …`.
- **`api-key-header-env-var`** — single env var, used as a custom header like `X-API-Key`. Capture the header name.
- **`multi-secret`** — multiple env vars. Capture each `config-key → env-var` pairing.
- **`basic-auth`** — username + password env vars.
- **`oauth-with-refresh`** — leave a `// TODO` placeholder in `loadCredentials`. Tell the user they'll need to implement the OAuth flow before the connector works.
- **`custom`** — anything else (mTLS, signed URLs, etc.). Same TODO treatment.

See `references/auth-patterns.md` for per-scheme `loadCredentials` snippets.

### Step 4 — API basics

Ask: *"What's the API base URL? Any rate limit or versioning header you know about?"*

Defaults:
- **Rate limit**: 60/min
- **Read timeout**: 30s
- **User-Agent**: `narai-custom-<slug>`

### Step 5 — Action surface

Ask: *"What actions should this connector expose? Just describe them — name, what it does, what params, what it returns."*

Write the Zod schemas, pick HTTP methods/endpoints, and assign default classifications:

- `get_*`, `list_*`, `search_*`, `query_*`, `fetch_*` → `read`
- `create_*`, `post_*`, `send_*`, `update_*`, `patch_*` → `write`
- `delete_*`, `remove_*`, `archive_*` → `delete`
- `grant_*`, `revoke_*` → `privilege`

Override on user signal ("this one mutates state" → classify as `write` even if the name says `get`).

See `references/action-design.md` for Zod schema patterns and the full classification → approval-mode table.

### Step 6 — Approval mode (only if non-read actions exist)

Ask: *"For the write/delete actions, how should the user approve them — `auto`, `confirm_once`, `confirm_each`, or `grant_required`?"*

Defaults:
- `read` → `auto`
- `write` → `confirm_once`
- `delete` → `confirm_each`
- `admin` / `privilege` → `grant_required`

Skip entirely if all actions are read-only.

### Step 7 — Confirmation

Show:
- File tree that will be created
- Actions table with classifications
- Auth scheme + env vars
- Scope path

Ask: *"Anything to change before I scaffold?"* Wait for explicit OK.

### Stamp (API wrapper)

Templates: `assets/templates/index.mjs.tmpl`, `assets/templates/bin.tmpl`, `assets/templates/connector-SKILL.md.tmpl`.

| Placeholder | Example |
|---|---|
| `{{SLUG}}` | `stripe` |
| `{{ServicePascal}}` | `Stripe` |
| `{{DESCRIPTION}}` | `Read-only Stripe connector: customers, charges, invoices.` |
| `{{API_BASE}}` | `https://api.stripe.com` |
| `{{RATE_LIMIT_PER_MIN}}` | `60` |
| `{{CREDENTIAL_ENV_VAR}}` | `STRIPE_API_KEY` |
| `{{AUTH_HEADER_ENTRY}}` | `` Authorization: `Bearer ${creds.token}` `` |
| `{{ACTIONS_DICTIONARY}}` | JS object literal of action handlers |
| `{{ACTIONS_TABLE_MD}}` | Markdown table of actions |
| `{{FIRST_ACTION}}` | First action name (used in smoke test) |

After stamping:
1. `chmod +x <bin>`
2. Open `<scope>/.connectors/config.yaml` (create if missing — minimal: `connectors: {}`) and append the `<slug>` entry.
3. Report what was created with absolute paths.

### Verify (API wrapper)

```sh
# Smoke-test the bin shim
<scope>/.connectors/connectors/<slug>/bin/<slug> --action <first-action> --params '{}'
```

Without credentials, expect `{"status":"error","error_code":"CONFIG_ERROR",…}` — correct shape, testing dispatch plumbing.

```sh
# End-to-end via the hub
node -e 'import("narai-primitives").then(({gather}) => gather({prompt:"call <slug> <first-action>"}).then(r => console.log(JSON.stringify(r, null, 2))))'
```

Common failure causes:
- `bin` not executable (`chmod +x`)
- `config.yaml` paths not absolute (must not use `~/...`)
- `index.mjs` import path wrong (must be `narai-primitives/toolkit`)

## Flavor: Shell-command gate

Trigger: user wants to gate a Bash command — deny prod kubectl, ask before force push, block destructive operations in certain environments.

No `index.mjs`, no `bin/`. The connector is purely declarative (`gates.json`).

### Checklist

1. **Slug** — short identifier (e.g., `prod-kubectl`, `deploy-guard`).
2. **Description** — one sentence.
3. **Rules** — for each rule, ask:
   - Pattern (regex) the command must match
   - Decision: `deny` / `ask` / `allow`
   - Reason (shown to the user in the prompt)
4. **Scope** — project or user (same as API wrapper).

### Stamp (shell-gate)

Templates: `assets/templates/shell-gate/gates.json.tmpl`, `assets/templates/shell-gate/SKILL.md.tmpl`.

Substitutions: `{{SLUG}}`, `{{DESCRIPTION}}`, `{{RULES}}` (JSON array), `{{RULES_TABLE}}` (markdown table), `{{ServicePascal}}`.

After stamping:

**First-run wiring** (if `<scope>/.connectors/connector-gate.mjs` doesn't exist yet):
1. Stamp `assets/templates/_runtime/connector-gate.mjs.tmpl` to `<scope>/.connectors/connector-gate.mjs`. Make it executable. The template is ESM; stamp the content verbatim.
2. Call `ensureSettingsHook(<scope>/.claude/settings.json, <abs-path-to-connector-gate.mjs>)` from `lib/settings-wiring.mjs`. This adds the `PreToolUse` hook entry. Settings.json is backed up to `<file>.bak-<timestamp>` before any write.

Subsequent shell-gate connectors do **not** repeat the first-run wiring — `connector-gate.mjs` auto-discovers all `<scope>/.connectors/connectors/*/gates.json` at runtime.

**Register** — call `registerConnector(<scope>, <slug>, {skill: <abs-path>, bin: null})` from `lib/connector-registry.mjs`.

### Verify (shell-gate)

Run the gate script directly with a synthetic payload to confirm rule evaluation:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"kubectl delete pod --all -n prod"}}' \
  | node <scope>/.connectors/connector-gate.mjs
```

Expect a JSON object with `hookSpecificOutput.permissionDecision` set to `"deny"` (or `"ask"` depending on the rule).

## Flavor: Composite orchestrator

Trigger: user describes a multi-step flow that calls existing connectors in sequence — pull data from one service, transform or summarize it, post results to another.

### Checklist

1. **Slug + description**
2. **Dependencies** — which existing connectors will this call? List slugs. Flag any that aren't yet installed.
3. **Goal** — what does the composite produce?
4. **Actions** — name + params + return shape for each (typically 1-3 actions).
5. **Scope** — project or user.

### Stamp (composite)

Templates: `assets/templates/composite/index.mjs.tmpl`, `assets/templates/composite/bin.tmpl`, `assets/templates/composite/SKILL.md.tmpl`.

The `index.mjs` calls `gather()` to invoke dependency connectors rather than making HTTP calls directly.

**Register** — call `registerConnector(<scope>, <slug>, {skill: <abs-path>, bin: <abs-bin-path>})` from `lib/connector-registry.mjs`.

### Verify (composite)

```sh
<scope>/.connectors/connectors/<slug>/bin/<slug> --action <first-action> --params '{}'
```

Expect either a success envelope (if dependencies are configured) or a `CONFIG_ERROR` from a missing dependency connector — either is the correct dispatch shape.

## Flavor: Knowledge-only

Trigger: user wants to document a workflow but no code is needed — runbooks, checklists, process descriptions that the planner should be able to invoke by name.

No `index.mjs`, no `bin/`, no `gates.json`.

### Checklist

1. **Slug + description**
2. **Use cases** — when should the model invoke this skill? (A sentence or two.)
3. **Steps** — numbered runbook
4. **Caveats** — warnings, edge cases, things to watch out for

### Stamp (knowledge-only)

Template: `assets/templates/knowledge/SKILL.md.tmpl` only.

**Register** — call `registerConnector(<scope>, <slug>, {skill: <abs-path>, bin: null})` from `lib/connector-registry.mjs`.

### Verify (knowledge-only)

No binary to smoke-test. Verify:
1. The SKILL.md file exists at the expected path.
2. The `config.yaml` entry is present with `bin: null`.
3. Ask the user to confirm the runbook content looks right.

## Flavor: Custom (code-gen)

Trigger: the user's description doesn't fit any of the four shapes above.

### Approach

1. Discuss with the user what the connector needs to do. Explore the design before generating code.
2. Write `index.mjs` from scratch (or whatever files make sense). Anchor on the connector contract — see `references/connector-contract.md`.
3. Stamp `SKILL.md` covering the actions / gates / behavior generated.
4. Append the entry to `config.yaml`.

Use `references/auth-patterns.md` and `references/action-design.md` as building blocks for the code-gen.

### Register

Call `registerConnector(<scope>, <slug>, {skill: <abs-path>, bin: <abs-bin-path-or-null>})` from `lib/connector-registry.mjs`.

## First-run wiring

The first time a gate-bearing connector is created (shell-gate flavor, or any custom connector that ships `gates.json`) in a given scope:

1. Check whether `<scope>/.connectors/connector-gate.mjs` already exists via `hasConnectorGateHook(<scope>/.claude/settings.json, <scope>/.connectors/connector-gate.mjs)` from `lib/settings-wiring.mjs`.
2. If not: stamp `assets/templates/_runtime/connector-gate.mjs.tmpl` to `<scope>/.connectors/connector-gate.mjs`. The template is ESM; stamp verbatim. Make the file executable.
3. Call `ensureSettingsHook(<scope>/.claude/settings.json, <abs-path-to-connector-gate.mjs>)`. This adds a `PreToolUse` hook entry. The function is idempotent — safe to call on every run.
4. Settings.json is backed up to `<file>.bak-<timestamp>` before any write.

After first run, subsequent shell-gate connectors skip stamping — `connector-gate.mjs` auto-discovers all `<scope>/.connectors/connectors/*/gates.json` at runtime.

## Policy gate is automatic

Every connector built on `createConnector` from `narai-primitives/toolkit` gets the policy gate **automatically**. Classification (`read` / `write` / `delete` / `admin` / `privilege`), approval-mode resolution (`auto` / `confirm_once` / `confirm_each` / `grant_required`), escalation, audit logging, and hardship recording all flow from the toolkit — no extra modules, no approval logic to write yourself.

What you **do** choose:

- The **classification** of each action (defaults to `read`).
- The **approval mode** for the connector (defaults to `auto` for read-only connectors).

Both surface in the interview only when relevant.

## When NOT to use this skill

- **Modifying an existing connector.** Edit the file directly.
- **Wrapping an MCP server.** Different abstraction — point the user at the Claude Code MCP docs.
- **Querying a supported database.** `narai-primitives/db` already covers postgres, mysql, sqlite, mssql, mongodb, dynamodb, oracle. See `references/db-agent-pointer.md`.
- **Contributing a builtin connector.** That's a PR to `narailabs/narai-primitives` — different scaffolding, plugin layer, marketplace entry.

## Next steps (tell the user)

After verification:

1. **Set credentials**: `export <ENV_VAR>="…"` (or persist in shell rc). Not applicable for knowledge-only and most shell-gate connectors.
2. **Run a real action**: `node <bin> --action <action> --params '<real-params>'`. Should return `{"status":"success","data":…}`. Not applicable for knowledge-only.
3. **(Optional) Add tests**: drop happy-path tests in `tests/` using vitest if installed locally.
4. **(If broadly useful)** Send a PR to `narailabs/narai-primitives` to promote to a builtin.

If auth scheme was `oauth-with-refresh` or `custom`, flag: *"You'll need to implement the OAuth/custom flow in `loadCredentials` in `index.mjs` before the connector works against the live API."*

## References

- `references/connector-contract.md` — the contract every connector follows; use as the anchor for custom code-gen
- `references/flavor-authoring.md` — how to add a 6th flavor (template structure, checklist format, registration)
- `references/research-patterns.md` — when to use WebFetch vs WebSearch vs context7; how to confirm findings with the user
- `references/auth-patterns.md` — auth schemes and `loadCredentials` snippets for API wrapper connectors
- `references/action-design.md` — Zod schema patterns, classification rules, approval-mode table for API wrapper actions
- `references/db-agent-pointer.md` — when to point the user at the bundled db connector instead of building a new one
