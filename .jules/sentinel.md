## 2026-05-21 - [Fix JSON and HTTP Authorization log credential leak]
**Vulnerability:** The existing `scrubSecrets` and `scrubSqlSecrets` functions only reacted to literal equality definitions (i.e., `password='xyz'`), meaning they missed credentials embedded within JSON (`"password":"xyz"`) or HTTP request header dictionaries (`Authorization: Bearer xyz`).
**Learning:** Hard-coded regular expressions targeting a single language format (SQL string definitions) are insufficient for log files handling heterogeneous application contexts like REST APIs and JSON payload outputs.
**Prevention:** Build comprehensive regular expressions that match arbitrary delimiter structures (`:` and `=`) and specific sensitive headers (like `Authorization`) while preserving context so formatting isn't mangled.

## 2026-06-20 - [Fix SQL Injection Bypass via Multi-Dialect Parsing]
**Vulnerability:** SQL injection protection in multi-dialect environments like `src/connectors/db/lib/policy.ts` relied on regex-based comment stripping and statement splitting, ignoring the differing string escape semantics (e.g. Standard SQL literal vs. MySQL backslash escapes).
**Learning:** Hard-coded regular expressions or single-dialect parsing strategies leave systems vulnerable to SQL injection bypass. Attackers can exploit parser discrepancies by embedding statements that look like strings in one dialect but execute as SQL in another (e.g., `SELECT * FROM t WHERE k = '\'; DROP TABLE users; -- '`).
**Prevention:** Implement a 'fail-closed' dual-mode parsing strategy instead of regexes. Evaluate SQL under both backslash-as-literal and backslash-as-escape semantics, throwing an error if the modes disagree on boundaries, or if ambiguous constructs like `[` or `/*!` are encountered.
