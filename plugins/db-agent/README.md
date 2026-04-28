# db-agent-plugin

Claude Code plugin that wraps [`narai-primitives/db`](https://www.npmjs.com/package/narai-primitives).

Exposes the `db-agent` skill. Every query passes through the policy gate before any driver loads or any connection opens. V2.0 vocab and defaults:

- `read` (SELECT/EXPLAIN/SHOW/DESCRIBE/WITH) → executed through the driver with row/timeout caps
- `write` (INSERT/UPDATE/REPLACE/MERGE/UPSERT) → escalates by default
- `delete` (DELETE/TRUNCATE) → returned as formatted SQL, never executed
- `admin` (CREATE/DROP/ALTER/RENAME) → returned as formatted SQL, never executed
- `privilege` (GRANT/REVOKE) → hard-denied

Install via Claude Code's plugin marketplace. The `SessionStart` hook installs `narai-primitives` into the plugin's data directory on first use.
