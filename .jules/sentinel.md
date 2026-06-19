## 2026-05-21 - [Fix JSON and HTTP Authorization log credential leak]
**Vulnerability:** The existing `scrubSecrets` and `scrubSqlSecrets` functions only reacted to literal equality definitions (i.e., `password='xyz'`), meaning they missed credentials embedded within JSON (`"password":"xyz"`) or HTTP request header dictionaries (`Authorization: Bearer xyz`).
**Learning:** Hard-coded regular expressions targeting a single language format (SQL string definitions) are insufficient for log files handling heterogeneous application contexts like REST APIs and JSON payload outputs.
**Prevention:** Build comprehensive regular expressions that match arbitrary delimiter structures (`:` and `=`) and specific sensitive headers (like `Authorization`) while preserving context so formatting isn't mangled.
## 2026-05-22 - [Performance Optimization for Audit Regexes]
**Vulnerability:** The regexes used for scrubbing sensitive data in `scrubSecrets` and `scrubSqlSecrets` were not vulnerable to catastrophic backtracking (ReDoS) since the alternations were mutually exclusive (e.g. `(?:\\.|[^'\\])*`).
**Learning:** Swapping the order of alternations in mutually exclusive non-capturing groups to check the most common case first (e.g. `(?:[^'\\]|\\.)*`) is a linear performance optimization for the JS regex engine, rather than a ReDoS fix.
**Prevention:** Accurately classify regex performance optimizations versus security vulnerabilities to ensure PR descriptions reflect true impact.
