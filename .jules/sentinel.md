## 2026-05-21 - [Fix JSON and HTTP Authorization log credential leak]
**Vulnerability:** The existing `scrubSecrets` and `scrubSqlSecrets` functions only reacted to literal equality definitions (i.e., `password='xyz'`), meaning they missed credentials embedded within JSON (`"password":"xyz"`) or HTTP request header dictionaries (`Authorization: Bearer xyz`).
**Learning:** Hard-coded regular expressions targeting a single language format (SQL string definitions) are insufficient for log files handling heterogeneous application contexts like REST APIs and JSON payload outputs.
**Prevention:** Build comprehensive regular expressions that match arbitrary delimiter structures (`:` and `=`) and specific sensitive headers (like `Authorization`) while preserving context so formatting isn't mangled.
## 2025-02-28 - ReDoS Vulnerability in Audit Log Regex

**Vulnerability:** A Regular Expression Denial of Service (ReDoS) vulnerability could be triggered in `src/connectors/db/lib/audit.ts` and `src/toolkit/audit/writer.ts` by passing heavily escaped strings to the secret-scrubbing regular expressions (e.g., `SENSITIVE_SQUOTE_RE`).
**Learning:** The expressions used an alternation inside a non-capturing group that put the escaped character match (`\\.`) before the non-escaped character class (`[^'\\]`). This caused the regex engine to backtrack catastrophically on long sequences of backslashes.
**Prevention:** In regular expression alternations, always prioritize non-escaped character classes over escaped sequences (e.g., use `(?:[^'\\]|\\.)*` instead of `(?:\\.|[^'\\])*`) to prevent catastrophic backtracking.
