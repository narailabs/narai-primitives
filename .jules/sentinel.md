## 2026-05-21 - [Fix JSON and HTTP Authorization log credential leak]
**Vulnerability:** The existing `scrubSecrets` and `scrubSqlSecrets` functions only reacted to literal equality definitions (i.e., `password='xyz'`), meaning they missed credentials embedded within JSON (`"password":"xyz"`) or HTTP request header dictionaries (`Authorization: Bearer xyz`).
**Learning:** Hard-coded regular expressions targeting a single language format (SQL string definitions) are insufficient for log files handling heterogeneous application contexts like REST APIs and JSON payload outputs.
**Prevention:** Build comprehensive regular expressions that match arbitrary delimiter structures (`:` and `=`) and specific sensitive headers (like `Authorization`) while preserving context so formatting isn't mangled.

## YYYY-MM-DD - Dual-mode State Machine for SQL Parsing
**Vulnerability:** Regex-based SQL comment stripping was prone to SQL injection / policy bypasses due to ignoring string boundaries like quotes or backticks.
**Learning:** Replacing regex with a state machine prevents bypasses (e.g., hiding comments inside quotes). To account for multi-dialect escaping issues (e.g., standard SQL vs Postgres/MySQL handling of backslash escapes), a dual-mode union splitting should be used to parse treating \ as literal and escape, returning both interpretations for safety without failing open.
**Prevention:** Always use boundary-aware state machine parsers over raw regexes when parsing and modifying SQL boundaries, especially in multi-statement splits and comment strippings. Use dual-mode parsing when dialect is unknown.
