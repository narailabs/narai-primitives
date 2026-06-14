## 2026-05-21 - [Fix JSON and HTTP Authorization log credential leak]
**Vulnerability:** The existing `scrubSecrets` and `scrubSqlSecrets` functions only reacted to literal equality definitions (i.e., `password='xyz'`), meaning they missed credentials embedded within JSON (`"password":"xyz"`) or HTTP request header dictionaries (`Authorization: Bearer xyz`).
**Learning:** Hard-coded regular expressions targeting a single language format (SQL string definitions) are insufficient for log files handling heterogeneous application contexts like REST APIs and JSON payload outputs.
**Prevention:** Build comprehensive regular expressions that match arbitrary delimiter structures (`:` and `=`) and specific sensitive headers (like `Authorization`) while preserving context so formatting isn't mangled.

## 2026-06-14 - [Fix ReDoS vulnerabilities in audit logging regexes]
**Vulnerability:** The regular expressions used for sensitive data redaction in `scrubSecrets` and `scrubSqlSecrets` (e.g. `(?:\\.|[^'\\])*`) were vulnerable to Regular Expression Denial of Service (ReDoS). A long, unclosed string combined with complex patterns could cause catastrophic backtracking.
**Learning:** In regular expression alternations, placing the escaped sequence first (`\\.`) forces the regex engine to repeatedly check for backslashes even for normal characters, which scales poorly and leads to ReDoS. The non-escaped character class (`[^'\\]`) should be prioritized.
**Prevention:** To prevent ReDoS from catastrophic backtracking, regex alternations must prioritize non-escaped character classes over escaped sequences (e.g., `(?:[^'\\]|\\.)*`). This ensures the fast path is taken for the vast majority of characters.
