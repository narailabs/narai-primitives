## 2024-05-18 - Escaped Quotes in Audit Redaction
**Vulnerability:** Audit logs leaked credentials if the credential value contained an escaped quote (`password='leaked\password\`). The regex `'[^']*'` stopped at the first escaped quote.
**Learning:** Naive regex for quote-matching fails on escaped characters.
**Prevention:** Use `'(?:[^'\\]|\\.)*'` for strings to handle escaped characters gracefully.
