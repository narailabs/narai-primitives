## 2024-05-18 - Missing try-catch around policy statement splitting and deciding
**Vulnerability:** Unhandled exceptions thrown during SQL comment parsing (e.g., "Ambiguous SQL statement boundaries") could bubble up in the `checkQuery` and `_checkSingleStatement` entry points, potentially crashing the connector and leaking stack traces.
**Learning:** `_splitStatements` and `_decideOne` (which calls `_formatStatement` and `_stripComments`) can throw on maliciously crafted ambiguous SQL. The outer loop did not catch these.
**Prevention:** Ensure entry points to policy evaluation wrap all internal throwing routines in a `try...catch` block to fail closed and emit a safe "deny" decision rather than bubbling the unhandled exception.
