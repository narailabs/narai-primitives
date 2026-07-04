## $(date +%Y-%m-%d) - Regex Alternation Loop Unrolling

**Learning:** Replacing regex alternations used for escaping, such as `(?:[^'\\]|\\.)*`, with loop unrolled structures like `[^'\\]*(?:\\.[^'\\]*)*` provides significant O(N) linear performance improvements and avoids Catastrophic Backtracking (ReDoS) vulnerability on long inputs.
**Action:** Always prefer loop unrolling over alternation inside quantifiers for matching escaped strings or delimiters in regexes unless JS backreferences (`\1`) explicitly prohibit it inside character classes.
