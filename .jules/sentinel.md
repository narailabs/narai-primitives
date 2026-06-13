## 2024-05-18 - ReDoS in Audit Redaction

**Vulnerability:** Catastrophic backtracking (ReDoS) was present in `scrubSecrets` and `scrubSqlSecrets` due to unbounded nested repetition in quoted string parsing: `(?:\\\\.|[^'\\\\])*`. A malicious payload like `password="\\\\a\\\\a\\\\a...` with no closing quote could cause exponential or quadratic execution time (dependent on the JS engine).

**Learning:** The pattern `(?:\\.|[^"\\\\])*` was originally written optimally for short strings, but catastrophic backtracking occurs during failure cases (unmatched quote) if the alternatives are not evaluated efficiently by the JS regex engine. Backreferences inside character classes (like `[^\4]`) are invalid in JS regexes, which prevented using strict loop unrolling for dynamic quote boundaries. Instead, simply swapping the alternatives to prioritize the non-escaped character class `(?:[^"\\\\]|\\\\.)*` drastically reduces backtracking branches by allowing fast consumption of normal characters.

**Prevention:** When matching quoted strings with escape sequences, always place the non-escaped character match before the escaped sequence match (e.g. `(?:[^"\\]|\\.)*` instead of `(?:\\.|[^"\\])*`) to force the engine to match eagerly and prevent ReDoS on failure. Avoid using backreferences inside character classes as it's invalid JS regex syntax.
