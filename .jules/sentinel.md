## 2024-05-18 - JavaScript Dynamic Regex Unrolling
**Vulnerability:** Regular Expression Denial of Service (ReDoS) vulnerability in standard string quote matching regexes, like `(?:\\.|[^'\\])*`.
**Learning:** ReDoS hotspots flagged by static analysis tools (SAST) can be safely avoided by unrolling the string-matching loop (e.g. `[^'\\]*(?:\\.[^'\\]*)*`). However, JavaScript lacks support for backreferences inside character classes. This means you cannot effectively unroll a regex loop that dynamically determines its delimiter via a backreference (like `\4`).
**Prevention:** Avoid blindly applying the unrolled loop pattern to dynamic regexes with backreferences. Only unroll regex loops where the delimiter is static (e.g. specifically single or double quotes).
