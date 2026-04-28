---
name: create-connector
description: |
  Use this skill whenever the user wants to add a new agent connector to their
  @narai connectors workspace — wrapping a SaaS API, REST endpoint, GraphQL
  endpoint, SDK, or CLI tool into the canonical @narai connector shape (CLI +
  library + Claude Code plugin). Trigger even if the user doesn't say
  "connector" explicitly: phrases like "I want to query Stripe from Claude",
  "add Slack to our agents", "wrap our internal orders API", "connect
  Salesforce", "I have a GraphQL endpoint we need exposed", "make a Linear
  agent" all warrant this skill. Walks the user through identity, auth, and
  action-surface questions, then scaffolds the package, plugin layer, and tests
  by stamping out canonical templates and generating per-connector code. Do NOT
  use for: modifying existing connectors (just edit the file), wrapping MCP
  servers (different abstraction), or querying databases (db-agent-connector
  already covers postgres/mysql/sqlite/mssql/mongodb/dynamodb/oracle).
---

# create-connector

Scaffolds a new agent connector that follows the canonical `@narai/*-agent-connector` pattern. The goal is to take a user from "I want to wrap X" to a working, testable, plugin-ready connector in one session — without them needing to know the toolkit's internals.

## Workspace location

The skill scaffolds into the user's **connectors workspace** — the directory containing their existing `@narai/*-agent-connector` packages (alongside `connector-toolkit`, `connector-hub`, `connector-config`).

Resolution order:

1. **`$NARAI_CONNECTORS_WORKSPACE`** — explicit override env var.
2. **Auto-detect** by walking up from `cwd` looking for a directory whose entries include `connector-toolkit/` and at least one `*-agent-connector/`. If found, use that.
3. **Default**: `~/src/connectors/`. Confirm with the user during interview.

In examples below, paths are written as `<workspace>/...` — substitute the resolved workspace root. The canonical reference connector for templates is `<workspace>/notion-agent-connector/`.

## When to invoke

Use this skill when the user wants to **create a new connector**. The classic phrasings:

- "I want to wrap the Stripe API"
- "Make me a Slack connector"
- "We need a connector for our internal orders API"
- "Add Linear to our agents"
- "Wrap this CLI so Claude can use it"

Also fire on near-misses where the intent is clear even without the word "connector":

- "I want to query Stripe from Claude"
- "Connect Salesforce to Claude Code"
- "Make a thing that lets me search Jira from Claude"

**Do NOT use this skill for:**

- **Modifying an existing connector**. Just edit the file directly. The skill is for fresh scaffolding only.
- **Wrapping an MCP server**. MCP servers and connectors are different abstractions in Claude Code. Point the user at the Claude Code MCP docs.
- **Querying a database**. `db-agent-connector` (already in the workspace) covers postgres, mysql, sqlite, mssql, mongodb, dynamodb, and oracle. See `references/db-agent-pointer.md` for the redirect playbook. The only exception is a database backend db-agent doesn't support — and even then, suggest extending db-agent's driver registry rather than starting fresh.
- **Pulling wiki/Mermaid concerns into a connector**. The workspace `CLAUDE.md` calls this split out as load-bearing.

## Quick triage

Open with **one** question: *"What system do you want to connect?"* Listen to the answer and classify into one of these paths:

| Signal | Path |
|---|---|
| SaaS API (Stripe, Slack, Linear, Salesforce, etc.) | scaffold |
| Internal REST API at the user's company | scaffold |
| GraphQL endpoint | scaffold; client uses single `POST /graphql` pattern |
| SDK-wrapped service (e.g., a service with a published SDK) | scaffold; SDK goes in `dependencies` |
| CLI tool to wrap | scaffold; client method bodies shell out via `child_process.execFile` |
| Database query (Postgres, MySQL, etc.) | redirect to `db-agent-connector` (see `references/db-agent-pointer.md`) |
| MCP server | out of scope; point at Claude Code MCP docs |
| Unsure | present the menu, let the user pick |

Pick a path before going deeper. Don't ask 12 questions if the user just said "Stripe" — the path is obvious; you can confirm details during interview.

## Policy gate is shared infrastructure

Before the interview, set this expectation explicitly: every connector built on `@narai/connector-toolkit` gets the policy gate **automatically**. That means classification (`read` / `write` / `delete` / `admin` / `privilege`), approval-mode resolution (`auto` / `confirm_once` / `confirm_each` / `grant_required`), escalation, audit logging, and hardship recording all flow from the toolkit — you don't choose a "policy-gated template", you don't import any extra modules, and you don't write any approval logic yourself.

What you **do** choose:

- The **classification** of each action (defaults to `read`).
- The **approval mode** for the connector (defaults to `auto` for read-only connectors).

Both are surfaced in the interview only when relevant.

## Interview

Conversational, not a fixed form. Capture the essence in **4–6 quick exchanges**, then generate a draft and let the user react. People react faster than they author from scratch.

### 1. Identity

Ask: *"What's the service slug, and is there anything special about the package name or bin?"*

Defaults you can suggest:

- **Service slug**: `stripe`, `slack`, `linear`, `acme` (lowercase, no spaces, no hyphens — used everywhere).
- **Package name**: `@narai/<slug>-agent-connector`.
- **Bin name**: `<slug>-agent`.
- **Description**: one sentence describing what the connector exposes (e.g., "Read-only Stripe connector: customers, charges, invoices.").
- **Workspace path**: `<workspace>/<slug>-agent-connector` where `<workspace>` resolves per the rules in the **Workspace location** section above.

Record these. Move on.

### 2. Auth

Ask: *"How does authentication work for this API?"*

Map the answer to one of:

- **`bearer-token-env-var`** (default) — single env var like `STRIPE_API_KEY`, used as `Authorization: Bearer ...`.
- **`api-key-header-env-var`** — single env var, used as a custom header like `X-API-Key`. Capture the header name.
- **`multi-secret`** — multiple env vars (e.g., `GITHUB_TOKEN` + `GITHUB_OWNER`). Capture each pairing of config-key → env-var.
- **`basic-auth`** — username + password env vars.
- **`oauth-with-refresh`** — **NOT TEMPLATED**. Tell the user the scaffold will leave a placeholder `loadCredentials` they need to fill in. See `references/auth-patterns.md` for the OAuth flow guidance.
- **`custom`** — anything else (mTLS, signed URLs, etc.). Scaffold with a placeholder; point at the workspace's existing connectors as references.

If the user picks oauth-with-refresh or custom, flag this clearly: *"The scaffold will leave a TODO in `loadCredentials` — you'll need to implement the actual auth flow. The rest of the connector will work."*

### 3. API basics

Ask: *"What's the API base URL? Any rate limit you know about? Any versioning header the API requires?"*

Defaults:

- **Rate limit**: 60/min. Adjust based on what the user knows about the API.
- **Read timeout**: 30s.
- **User-Agent**: `@narai/<slug>-agent-connector` (the package name).
- **Versioning header**: typically none. Notion sets `Notion-Version`; Stripe doesn't need one. If the API requires a versioning header, capture both name and value.

### 4. Action surface

Ask: *"What actions should this connector expose? Just describe them in your own words — name, what it does, what params it takes, what it returns."*

The user will say something like: *"`get_customer` takes an id, returns the customer. `list_charges` takes optional `customer_id` and `limit` (default 25), returns a list of charges with pagination."*

You write the Zod schemas, pick HTTP methods/endpoints (ask if not obvious), and assign default classifications:

- Names starting with `get_*`, `list_*`, `search_*`, `query_*`, `fetch_*` → `read`.
- Names starting with `create_*`, `post_*`, `send_*`, `update_*`, `patch_*` → `write`.
- Names starting with `delete_*`, `remove_*`, `archive_*` → `delete`.
- Names starting with `grant_*`, `revoke_*` → `privilege`.

Override on user signal — if they say *"this one mutates state"*, mark it as write even if the name says otherwise.

See `references/action-design.md` for Zod schema patterns and the full classification → approval-mode table.

### 5. Approval mode (only if non-read actions exist)

If any action is non-`read`, ask: *"For the write actions, how should the user approve them — `auto` (no prompt), `confirm_once` (per session), `confirm_each` (every call), or `grant_required` (out-of-band)?"*

Defaults:

- `read` → `auto`
- `write` → `confirm_once`
- `delete` → `confirm_each`
- `admin` / `privilege` → `grant_required`

If all actions are read, skip this question entirely.

### 6. Confirmation

Show the user a summary:

- File tree that will be created
- Actions table with classifications
- Dep versions (`@narai/connector-toolkit ^3.1.0`, etc.)
- Auth scheme
- Workspace target path

Ask: *"Anything to change before I scaffold?"* Wait for explicit OK. Don't write files until they say go.

## Scaffold

Templates live at `assets/templates/connector/`. Most files are stamped with placeholder substitution; the per-connector unique files are generated.

### Placeholders (substitute everywhere they appear)

**Identity:**
| Placeholder | Example value |
|---|---|
| `{{SERVICE_SLUG}}` | `stripe` — lowercase; used in directory names, package name, bin name, as `name` in `createConnector`, in plugin paths. **Hyphenated services**: keep hyphens here (`acme-msg`, `gcp-billing`) — npm package and bin names support hyphens. |
| `{{SERVICE_SLUG_UPPER}}` | `STRIPE` (or `ACME_MSG` for hyphenated) — env var prefixes. Convert hyphens to underscores. |
| `{{ServicePascal}}` | `Stripe` (or `AcmeMsg` for hyphenated) — class names, interface names. Strip both hyphens and underscores; PascalCase the words. |
| **Filenames inside `src/lib/`** use the slug with **underscores instead of hyphens** (e.g., `acme_msg_client.ts`, `acme_msg_error.ts`). The skill's templates use `{{SERVICE_SLUG}}` substituted into these filenames; for hyphenated slugs, do the hyphen-to-underscore swap before substituting. |

**Top-level (package.json / README.md / plugin.json):**
| Placeholder | Example |
|---|---|
| `{{DESCRIPTION}}` | `Read-only Stripe connector: customers, charges, invoices.` |
| `{{DESCRIPTION_SHORT}}` | `read-only Stripe connector` (used in src/index.ts header doc) |
| `{{API_BASE}}` | `https://api.stripe.com` |
| `{{RATE_LIMIT_PER_MIN}}` | `60` (or whatever the user said during interview) |

**Auth (cli.ts / client.ts / loadCredentials):**
| Placeholder | Example |
|---|---|
| `{{CREDENTIAL_ENV_VAR}}` | `STRIPE_API_KEY` (Bearer) or `ACME_API_KEY` (X-API-Key) or `ACME_MSG_TOKEN` — the **actual** env var name the user provided, not a derived `_TOKEN` suffix. Used in the CONFIG_ERROR message inside `index.ts`. For multi-secret auth, list the primary one (token) since that's what the error message names first. |
| `{{ENV_MAPPING_BODY}}` | `  token: "STRIPE_API_KEY",` (multiple lines for multi-secret) |
| `{{CLIENT_OPTIONS_FIELDS}}` | `  token: string;` (or `token: string;\n  owner: string;` for multi-secret) |
| `{{CLIENT_PRIVATE_FIELDS}}` | `  private readonly _token: string;` (one line per secret field) |
| `{{CLIENT_CONSTRUCTOR_ASSIGNMENTS}}` | `    this._token = opts.token;` (one line per secret field) |
| `{{CREDENTIALS_TYPE}}` | `{ token: string }` (or `{ token: string; owner: string }` etc.) |
| `{{CREDENTIALS_LOADER_BODY}}` | the full body of `loadServiceCredentials()`, see `references/auth-patterns.md` for templates per scheme |
| `{{AUTH_HEADER_ENTRIES}}` | `      Authorization: \`Bearer ${this._token}\`,` (Bearer) or `      "X-API-Key": this._token,` (API-key) |
| `{{EXTRA_HEADERS_ENTRIES}}` | extra service-specific headers (e.g., `      "Notion-Version": "2022-06-28",`) — empty string if none |

**README.md / plugin SKILL.md:**
| Placeholder | Example |
|---|---|
| `{{ACTIONS_TABLE}}` | full markdown table of actions with required/optional params |
| `{{FIRST_ACTION}}` | `list_customers` (the first action's name) |
| `{{FIRST_ACTION_EXAMPLE_PARAMS}}` | `{}` or `{"limit":10}` — a valid JSON value for the example invocation |
| `{{API_DESCRIPTION}}` | `the Stripe API with a STRIPE_API_KEY Bearer token` (one-line natural-language description for the plugin SKILL.md body) |
| `{{SKILL_DESCRIPTION}}` | the description string for the plugin SKILL.md frontmatter — phrased as "Use when the user asks about ..." |
| `{{CREDENTIAL_NOTE}}` | "The `STRIPE_API_KEY` must be a Stripe restricted key with read-only scope." (one paragraph for the README Install section) |
| `{{CREDENTIAL_INSTRUCTIONS}}` | one-paragraph credential-setup instructions for the plugin SKILL.md |
| `{{SAFETY_NOTE}}` | one-paragraph safety statement (for read-only: "Read-only by construction: client uses only GET against /v1/customers and /v1/charges. No write/delete endpoints can be reached.") |
| `{{READ_WRITE_NOTE}}` | "No write operations." for read-only connectors; for mixed: "Write actions require approval per the toolkit's policy gate." |

**Generated sections (replace the placeholder + the surrounding example comment):**
| Placeholder | What goes here |
|---|---|
| `{{PARAM_SCHEMAS}}` | one Zod schema declaration per action |
| `{{ACTIONS_DICTIONARY}}` | one `actionName: { description, params, classify, handler }` entry per action |
| `{{SERVICE_METHODS}}` | (in client.ts) one public method per action — e.g., `getCustomer(id) { return this.request<...>("GET", \`/v1/customers/${id}\`); }` |
| `{{RESPONSE_TYPES}}` | (in client.ts) one TypeScript interface per action's response shape |
| `{{HAPPY_PATH_TESTS}}` | (in cli.test.ts) one happy-path test per action |
| `{{CLIENT_METHOD_TESTS}}` | (in client_extras.test.ts) one test per public client method asserting URL/method/headers |

**Test cleanup:**
| Placeholder | Example |
|---|---|
| `{{TEST_CLIENT_CREDS}}` | `    token: "secret_test",` (single-secret) or both lines for multi-secret |
| `{{TEST_CLIENT_CREDS_OBJECT}}` | `{ token: "secret_test" }` |
| `{{INTEGRATION_ENV_CLEANUP}}` | `  delete process.env["STRIPE_API_KEY"];` (one line per env var; for multi-secret, one line each) |
| `{{FIRST_ACTION_PARAMS_JSON}}` | `{ limit: 1 }` — valid params for the first action, used in the integration test |

### Stamp these files (substitute placeholders, write to target dir)

Strip the `.tmpl` extension when writing:

- `package.json` ← `package.json.tmpl`
- `tsconfig.json` ← `tsconfig.json` (no placeholders, copy literal)
- `vitest.config.ts` ← `vitest.config.ts.tmpl`
- `LICENSE` ← `LICENSE` (literal)
- `.npmignore` ← `.npmignore`
- `.gitignore` ← `.gitignore` (literal)
- `README.md` ← `README.md.tmpl` (you'll fill in `{{ACTIONS_TABLE}}` and example params)
- `src/cli.ts` ← `src/cli.ts.tmpl` (build `{{ENV_MAPPING_BODY}}` from auth answers)
- `src/lib/<svc>_error.ts` ← `src/lib/error.ts.tmpl`
- `plugin/.claude-plugin/plugin.json` ← `plugin/.claude-plugin/plugin.json.tmpl`
- `plugin/hooks/hooks.json` ← `plugin/hooks/hooks.json.tmpl`
- `plugin/hooks/reminder.mjs` ← `plugin/hooks/reminder.mjs.tmpl`
- `plugin/bin/<svc>-agent` ← `plugin/bin/service-agent.tmpl` (rename to the bin name; chmod +x after writing)
- `plugin/skills/<svc>-agent/SKILL.md` ← `plugin/skills/service-agent/SKILL.md.tmpl`
- `plugin/commands/<svc>-agent.md` ← `plugin/commands/service-agent.md.tmpl`

### Generate these files (use templates as a frame; fill in service-specific code)

- **`src/lib/<svc>_client.ts`** — start from `src/lib/client.ts.tmpl` (the frame). Fill in `{{AUTH_HEADER_ENTRIES}}` based on auth scheme; fill in `{{EXTRA_HEADERS_ENTRIES}}` for any required versioning headers; fill in `{{CLIENT_OPTIONS_FIELDS}}`, `{{CLIENT_PRIVATE_FIELDS}}`, `{{CLIENT_CONSTRUCTOR_ASSIGNMENTS}}` based on multi-secret needs; fill in `{{CREDENTIALS_TYPE}}` and `{{CREDENTIALS_LOADER_BODY}}` from auth pattern; then **add public methods** for each action (one method per action, returning `Promise<{{ServicePascal}}Result<T>>`).
- **`src/index.ts`** — start from `src/index.ts.tmpl`. Replace the `{{PARAM_SCHEMAS}}` block with one Zod schema per action. Replace the `{{ACTIONS_DICTIONARY}}` block with one entry per action (description, params, classify, handler that calls the client method + `throwIfError` + shapes the response).
- **`tests/unit/cli.test.ts`** — fill in `{{TEST_CLIENT_CREDS}}`, `{{TEST_CLIENT_CREDS_OBJECT}}` per auth scheme. Generate one happy-path test per action (replace `{{HAPPY_PATH_TESTS}}`).
- **`tests/unit/<svc>_client_extras.test.ts`** — **rename from `client_extras.test.ts.tmpl` to `<svc>_client_extras.test.ts`** (e.g., `stripe_client_extras.test.ts`). Same lowercase-slug rule as `src/lib/`. Fill in `{{TEST_CLIENT_CREDS}}`. Generate one test per public client method asserting URL, method, headers (`{{CLIENT_METHOD_TESTS}}`).
- **`tests/integration/framework.test.ts`** — fill in `{{TEST_CLIENT_CREDS}}`, `{{INTEGRATION_ENV_CLEANUP}}` (one `delete process.env["..."];` line per credential env var — e.g., `  delete process.env["STRIPE_API_KEY"];`), `{{FIRST_ACTION}}` and `{{FIRST_ACTION_PARAMS_JSON}}`.
- **README.md actions table** and **plugin SKILL.md actions table** — same shape as notion-agent's, tailored to this connector's actions.

See `references/connector-anatomy.md` for the canonical shape, `references/auth-patterns.md` for the auth substitutions, and `references/action-design.md` for Zod patterns.

### Order of operations

1. Create the directory.
2. Stamp the literal-copy files first (LICENSE, tsconfig, .gitignore).
3. Stamp the placeholder files (package.json, README, plugin/, cli.ts, error.ts).
4. Generate the unique files (client.ts, index.ts, tests).
5. `chmod +x plugin/bin/<svc>-agent` so the bash shim is executable.
6. Report what was created with the absolute paths.

## Verify

Run, in order:

```bash
cd <new-connector-dir>
npm install
npm run build
npm run typecheck
npm test
node dist/cli.js --action <first-action> --params '{}'
```

Expectations:

- `npm install` clean. If `@narai/*` packages 404, the user lacks access to the private scope — flag and stop.
- `npm run build` clean (no TS errors). Errors here usually mean a generated file references a placeholder that wasn't substituted, or a Zod schema with bad syntax.
- `npm run typecheck` silent.
- `npm test` green.
- The smoke `node dist/cli.js` call should emit a JSON envelope on stdout. Without credentials configured, expect `{"status":"error","error_code":"CONFIG_ERROR",...}` — that's the **right** shape; we're testing the CLI plumbing, not connectivity.

If any step fails, surface the exact failing command and the relevant output. See `references/verification.md` for common failure modes.

## Next steps (tell the user)

After verification passes, list:

1. **Register the package**: `cd <new-connector-dir> && npm publish` (requires access to the `@narai` private scope).
2. **Set credentials**: `export <SVC>_TOKEN="..."` (or whatever auth env vars you defined) — or add to `~/.connectors/<slug>/config.yaml`.
3. **Run a live action**: `node dist/cli.js --action <first-action> --params '<real-params>'` — should return `{"status":"success","data":...}`.
4. **Install as a Claude Code plugin** if the user wants the slash command + skill: see `plugin/.claude-plugin/plugin.json`.
5. **Add evals**: drop a few prompts in `evals/evals.json` if the user wants quantitative tracking of connector behavior over time.

If the auth scheme was `oauth-with-refresh` or `custom`, also flag: *"You'll need to implement the OAuth/custom flow in `loadCredentials` before the connector will work against the live API."*

## Pointers

Canonical reference connector (the templates are snapshots of these files):

- `<workspace>/notion-agent-connector/` — read this for the full canonical shape.
- `<workspace>/connector-toolkit/src/index.ts` — toolkit's public API surface (3.4.0 at scaffolding time).

Reference docs in this skill:

- `references/connector-anatomy.md` — the createConnector contract, Result-envelope pattern, error-code taxonomy.
- `references/plugin-layer.md` — what every file in `plugin/` does.
- `references/auth-patterns.md` — auth scheme → scaffold output mapping.
- `references/action-design.md` — Zod schema patterns, classifications, handler shape.
- `references/db-agent-pointer.md` — when to redirect to existing db-agent-connector.
- `references/template-sync.md` — how the templates map to canonical files; re-sync procedure.
- `references/verification.md` — step-by-step smoke test, failure-mode triage.
