# Pointer: when to use db-agent-connector instead

If the user wants to query a database from Claude, the answer is almost always **install and configure the existing `db-agent-connector`**, not scaffold a new connector. This doc explains why and how to redirect.

## What db-agent-connector already does

Lives at `/Users/narayan/src/connectors/db-agent-connector/`. Single CLI surface, single library API, single Claude Code plugin — but speaks to **seven** database systems through a pluggable driver registry:

- PostgreSQL (`pg`)
- MySQL / MariaDB (`mysql2`)
- SQLite (`better-sqlite3`)
- Microsoft SQL Server (`mssql`)
- MongoDB (`mongodb`)
- Amazon DynamoDB (`@aws-sdk/client-dynamodb`)
- Oracle (`oracledb`)

Drivers are `optionalDependencies`, lazy-loaded on first use. A user querying only SQLite doesn't carry the weight of `pg` or `mssql`.

## Why a fresh action-dispatch connector is the wrong shape

- **Multi-state envelope**: db-agent emits `ok` / `present_only` / `denied` / `escalate` / `error`. The `present_only` state is unique to db-agent — it returns formatted SQL for the user to review without executing. Action-dispatch connectors don't have this state, and adding it ad-hoc would mean reimplementing db-agent's policy engine.
- **Operator-configurable safety**: db-agent reads policy rules from `~/.connectors/config.yaml` (V2.0 layout) under the `connectors.db.policy` slice: classifications `read` / `write` / `delete` / `admin` / `privilege` map to actions `allow` / `present` / `escalate` / `deny`. Plus `unbounded_select` (escalate SELECTs without WHERE/LIMIT) and a safety floor that rejects `admin: allow` and `privilege: allow`. Operator-tunable per server via the optional per-server `policy` block.
- **SQL keyword classification**: db-agent classifies queries by parsing the SQL keyword (`SELECT` → read, `INSERT/UPDATE/DELETE` → write, `CREATE/ALTER/DROP` → delete, `GRANT/REVOKE` → privilege). The toolkit's static `classify` field can't do this because the action shape is just "run this query".
- **Stateful connection pooling** with per-server config (driver, host, db, credentials, approval mode).

If a new connector tried to replicate this, it would be a ~2000-line lift duplicating work db-agent already shipped.

## How to redirect the user

When the interview triages to `database`:

1. **Identify the backend**: ask which DB engine. If it's one of the seven listed above, use db-agent. If it's something else (Snowflake, BigQuery, ClickHouse, Redis), see "Genuinely novel backends" below.

2. **Confirm db-agent is installed**: check whether `/Users/narayan/src/connectors/db-agent-connector/` has `node_modules/`. If not, `cd` there and run `npm install`.

3. **Walk through `~/.connectors/config.yaml`** (V2.0 layout — single shared config file with a `connectors.db.*` slice). Tell the user to read `db-agent-connector/CLAUDE.md` for the authoritative format. A minimal example:

   ```yaml
   connectors:
     db:
       policy:
         read: allow
         write: present
         delete: present
         admin: deny       # safety floor — `allow` is rejected by validation
         privilege: deny   # safety floor — `allow` is rejected by validation
         unbounded_select: escalate   # SELECTs lacking WHERE/LIMIT/OFFSET get escalated

       servers:
         prod:
           driver: postgres
           host: db.acme.com
           database: app
           user: readonly
           password: env:PROD_PG_PASSWORD   # provider:key form — see below
           approval_mode: confirm_each

       audit:
         enabled: true
         path: ~/.connectors/db-agent/audit.jsonl
   ```

   Repo-level overlay: `./.connectors/config.yaml` wins on per-key conflicts with the user-level file.

   Credential references inside the slice use a `provider:key` form: `env:VAR_NAME`, `keychain:NAME`, `file:path.json:dotted.key`, `cloud:alias`. Plain strings without a recognized prefix pass through as literals. Set the env var in your shell as usual.

4. **Smoke test**: `npx db-agent-connector --action query --params '{"server":"prod","sql":"SELECT 1"}'`.

The skill should produce this redirect without scaffolding any new files.

## Genuinely novel backends

If the user wants to query a backend db-agent doesn't yet support (Snowflake, BigQuery, ClickHouse, Redis, etc.):

- **Suggest extending db-agent's driver registry**, not building a fresh connector. The driver interface lives at `db-agent-connector/src/lib/drivers/`. Adding a new driver gets the user the policy gate, audit, escalation, and approval modes for free.
- If the user *insists* on a fresh action-dispatch connector for a non-SQL store (e.g., a key-value lookup that doesn't need policy gating), the skill can scaffold it — but warn that they're duplicating infrastructure db-agent already provides.

## Critical files for the user to read

- `/Users/narayan/src/connectors/db-agent-connector/CLAUDE.md` — authoritative documentation for db-agent.
- `/Users/narayan/src/connectors/db-agent-connector/src/connector.ts` — the policy-gate orchestration.
- `/Users/narayan/src/connectors/db-agent-connector/src/lib/policy.ts` — the SQL keyword classifier.
- `/Users/narayan/src/connectors/db-agent-connector/src/lib/plugin_config.ts` — config schema.
- `/Users/narayan/src/connectors/db-agent-connector/src/lib/drivers/` — driver registry pattern (for extension).
