---
name: create-connector
description: |
  Use this skill when the user wants to add a custom connector to their project —
  wrapping a SaaS API, REST endpoint, GraphQL endpoint, SDK, or CLI tool so
  Claude can call it via `gather()` from `narai-primitives`. Trigger even when
  the user doesn't say "connector" explicitly: phrases like "I want to query
  Stripe from Claude", "add Slack to our agents", "wrap our internal orders
  API", "connect Salesforce", "make a Linear agent" all warrant this skill.
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

## What gets created

```
<scope>/.connectors/connectors/<slug>/
├── SKILL.md         # Describes actions; read by gather()'s planner
├── index.mjs        # Uses createConnector from narai-primitives
├── bin/<slug>       # Shell shim → exec node ../index.mjs
└── (optional) tests/example.test.mjs
```

Plus one entry appended to `<scope>/.connectors/config.yaml`:

```yaml
connectors:
  <slug>:
    skill: <abs-path-to-connector-dir>      # path-style (config-loader supports it)
    bin:   <abs-path-to-bin>
    enabled: true
```

That's it — the connector is reachable via `gather()` immediately. No install, no publish, no restart.

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

**Do NOT use this skill for:**

- **Modifying an existing connector.** Just edit the file directly.
- **Wrapping an MCP server.** MCP servers and connectors are different abstractions in Claude Code. Point the user at the Claude Code MCP docs.
- **Querying a database.** `narai-primitives/db` covers postgres, mysql, sqlite, mssql, mongodb, dynamodb, oracle. See `references/db-agent-pointer.md`. Only suggest a custom DB connector if it's a backend the bundled `db` connector doesn't support.
- **Contributing a builtin connector to `narai-primitives`.** That's a different flow (PR to the bundle's repo, separate test suite, plugin marketplace entry). This skill is for end-user local connectors only.

## Policy gate is automatic

Every connector built on `createConnector` from `narai-primitives/toolkit` gets the policy gate **automatically**. Classification (`read` / `write` / `delete` / `admin` / `privilege`), approval-mode resolution (`auto` / `confirm_once` / `confirm_each` / `grant_required`), escalation, audit logging, and hardship recording all flow from the toolkit — you don't import any extra modules and don't write any approval logic yourself.

What you **do** choose:

- The **classification** of each action (defaults to `read`).
- The **approval mode** for the connector (defaults to `auto` for read-only connectors).

Both surface in the interview only when relevant.

## Interview

Conversational, not a fixed form. Capture the essentials in **5–7 quick exchanges**, then generate a draft and let the user react. People react faster than they author from scratch.

### 1. Scope

Ask: *"Should this connector be available only in this project, or for all your projects?"*

| Choice | Where it lives | Default for |
|---|---|---|
| **Project (default)** | `./.connectors/connectors/<slug>/` | repo-specific stuff ("our internal orders API") |
| **User** | `~/.connectors/connectors/<slug>/` | personal tools ("my company's Linear") |

Pick a sensible default based on the user's phrasing. Confirm with them. The scope determines:
- Where files get written
- Which `config.yaml` gets the entry (`./.connectors/config.yaml` for project, `~/.connectors/config.yaml` for user)

### 2. Identity

Ask: *"What's the service slug?"*

- **Slug**: lowercase, alphanumeric + hyphens (e.g., `stripe`, `slack`, `linear`, `acme`, `acme-orders`). Used everywhere — directory name, bin name, config key, envelope `name`.
- **Description**: one sentence (e.g., "Read-only Stripe connector: customers, charges, invoices.")

Record. Move on.

### 3. Auth

Ask: *"How does authentication work for this API?"*

Map the answer to one of:

- **`bearer-token-env-var`** (default) — single env var like `STRIPE_API_KEY`, used as `Authorization: Bearer …`.
- **`api-key-header-env-var`** — single env var, used as a custom header like `X-API-Key`. Capture the header name.
- **`multi-secret`** — multiple env vars (e.g., `GITHUB_TOKEN` + `GITHUB_OWNER`). Capture each pairing of `config-key → env-var`.
- **`basic-auth`** — username + password env vars.
- **`oauth-with-refresh`** — leave a `// TODO` placeholder in `loadCredentials`. Tell the user explicitly: *"You'll need to implement the OAuth flow before the connector will work."*
- **`custom`** — anything else (mTLS, signed URLs, etc.). Same TODO treatment.

See `references/auth-patterns.md` for per-scheme `loadCredentials` snippets.

### 4. API basics

Ask: *"What's the API base URL? Any rate limit or versioning header you know about?"*

Defaults:
- **Rate limit**: 60/min. Adjust if the user knows.
- **Read timeout**: 30s.
- **User-Agent**: `narai-custom-<slug>` (helps the upstream service identify the caller).

### 5. Action surface

Ask: *"What actions should this connector expose? Just describe them — name, what it does, what params, what it returns."*

The user will say something like *"`get_customer` takes an id, returns the customer. `list_charges` takes optional `customer_id` and `limit` (default 25), returns a list."*

You write the Zod schemas, pick HTTP methods/endpoints (ask if not obvious), and assign default classifications:

- Names starting with `get_*`, `list_*`, `search_*`, `query_*`, `fetch_*` → `read`
- Names starting with `create_*`, `post_*`, `send_*`, `update_*`, `patch_*` → `write`
- Names starting with `delete_*`, `remove_*`, `archive_*` → `delete`
- Names starting with `grant_*`, `revoke_*` → `privilege`

Override on user signal — if they say *"this one mutates state"*, classify as `write` even if the name says otherwise.

See `references/action-design.md` for Zod schema patterns and the full classification → approval-mode table.

### 6. Approval mode (only if non-read actions exist)

If any action is non-`read`, ask: *"For the write/delete actions, how should the user approve them — `auto` (no prompt), `confirm_once` (per session), `confirm_each` (every call), or `grant_required` (out-of-band)?"*

Defaults:
- `read` → `auto`
- `write` → `confirm_once`
- `delete` → `confirm_each`
- `admin` / `privilege` → `grant_required`

Skip entirely if all actions are read.

### 7. Confirmation

Show the user a summary:

- File tree that will be created
- Actions table with classifications
- Auth scheme + env vars
- Scope path (project or user)

Ask: *"Anything to change before I scaffold?"* Wait for explicit OK.

## Scaffold

Templates live at `assets/templates/`. Three files plus an optional test:

| Stamp | From template | Substitutions |
|---|---|---|
| `<scope>/.connectors/connectors/<slug>/index.mjs` | `assets/templates/index.mjs.tmpl` | slug, description, auth, action specs |
| `<scope>/.connectors/connectors/<slug>/bin/<slug>` | `assets/templates/bin.tmpl` | slug |
| `<scope>/.connectors/connectors/<slug>/SKILL.md` | `assets/templates/connector-SKILL.md.tmpl` | slug, description, action surface |
| `<scope>/.connectors/connectors/<slug>/tests/example.test.mjs` (optional) | `assets/templates/tests-example.mjs.tmpl` | slug, first action |

After stamping:

1. `chmod +x <bin>` so the shim is executable.
2. Open `<scope>/.connectors/config.yaml` (create it if missing — minimal valid file is `connectors: {}`) and append the entry under `connectors:`:
   ```yaml
   connectors:
     <slug>:
       skill: <abs-path-to-connector-dir>
       bin:   <abs-path-to-bin>
       enabled: true
   ```
3. Report what was created with absolute paths.

### Placeholders

| Placeholder | Example value |
|---|---|
| `{{SLUG}}` | `stripe` |
| `{{ServicePascal}}` | `Stripe` (PascalCase, hyphens stripped) |
| `{{DESCRIPTION}}` | `Read-only Stripe connector: customers, charges, invoices.` |
| `{{API_BASE}}` | `https://api.stripe.com` |
| `{{RATE_LIMIT_PER_MIN}}` | `60` |
| `{{CREDENTIAL_ENV_VAR}}` | `STRIPE_API_KEY` |
| `{{AUTH_HEADER_ENTRY}}` | `Authorization: \`Bearer ${creds.token}\`` (one line; for `X-API-Key` it's `"X-API-Key": creds.token,`) |
| `{{ACTIONS_DICTIONARY}}` | the JS object literal of action handlers (filled in from interview) |
| `{{ACTIONS_TABLE_MD}}` | markdown table of actions for the connector's SKILL.md |
| `{{FIRST_ACTION}}` | first action name, used in the smoke-test invocation |

## Verify

After scaffolding:

```sh
# 1. Smoke-test the bin in isolation (env vars set, real API call optional).
<scope>/.connectors/connectors/<slug>/bin/<slug> --action <first-action> --params '{}'
```

Expectation: a JSON envelope on stdout. Without credentials, expect `{"status":"error","error_code":"CONFIG_ERROR",…}` — that's the **right** shape; we're testing the dispatch plumbing, not connectivity.

```sh
# 2. End-to-end via the hub.
node -e 'import("narai-primitives").then(({gather}) => gather({prompt:"call <slug> <first-action>"}).then(r => console.log(JSON.stringify(r, null, 2))))'
```

Expectation: `gather()` plans `{ connector: "<slug>", action: "<first-action>", … }`, dispatches, returns either a success envelope (with credentials) or the same `CONFIG_ERROR` (without). The dispatch path is what's being verified.

If either fails, the most common causes are:
- `bin` not executable (`chmod +x`)
- `config.yaml` `skill:` and `bin:` paths not absolute (must be absolute, not `~/...`)
- `index.mjs` import path wrong (must be `narai-primitives/toolkit`, not the legacy `@narai/connector-toolkit`)

## Next steps (tell the user)

After verification:

1. **Set the credential**: `export <ENV_VAR>="…"` (or persist in their shell rc).
2. **Run a real action**: `node <bin> --action <action> --params '<real-params>'`. Should return `{"status":"success","data":…}`.
3. **(Optional) Add tests**: drop happy-path tests in `tests/` using vitest if installed locally, or skip — these are local connectors; tests are nice-to-have, not required.
4. **(If broadly useful)** Send a PR to `narailabs/narai-primitives` to promote the connector to a builtin — see that repo's CONTRIBUTING.md for the contributor flow (different scaffolding, with a plugin layer, marketplace entry, etc.).

If the auth scheme was `oauth-with-refresh` or `custom`, also flag: *"You'll need to implement the OAuth/custom flow in the `loadCredentials` block of `index.mjs` before the connector will work against the live API."*

## Pointers

- **Reference**: `references/connector-anatomy.md` — the createConnector contract, envelope shape, error codes.
- **Auth patterns**: `references/auth-patterns.md` — auth scheme → `loadCredentials` template per scheme.
- **Action design**: `references/action-design.md` — Zod schema patterns, classifications, handler shape.
- **DB redirect**: `references/db-agent-pointer.md` — when to point the user at the bundled `db` connector instead.
- **Builtin connectors** in `narai-primitives` (canonical examples to read for inspiration):
  - GitHub: https://github.com/narailabs/narai-primitives/tree/main/src/connectors/github
  - Notion: https://github.com/narailabs/narai-primitives/tree/main/src/connectors/notion
  - DB (policy-gated, more complex): https://github.com/narailabs/narai-primitives/tree/main/src/connectors/db
- **Legacy version of this skill** (when connectors used to scaffold as full `@narai/<svc>-agent-connector` repos with their own npm package + plugin layer): see `SKILL.legacy.md` in this directory.
