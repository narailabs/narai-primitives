
## 2024-05-17 - [CRITICAL] Fix missing Bearer/Basic token redaction in audit logs
**Vulnerability:** The `scrubSecrets` function in `src/toolkit/audit/writer.ts` correctly redacted `key='value'` secrets, but failed to redact HTTP `Authorization:` headers like `Bearer <token>` or `Basic <base64>`. Since toolkit often logs HTTP errors or headers as context strings in the audit logs (`events.jsonl`), tokens could be leaked in plaintext.
**Learning:** Security controls designed for one domain (e.g. key-value pairs like in SQL) are often insufficient for other domains (e.g. HTTP headers) sharing the same redaction function. The `scrubSecrets` function was missing HTTP auth redaction entirely.
**Prevention:** Always consider the full spectrum of data passing through logging utilities. If the utility logs HTTP payloads or requests, it must include HTTP-specific redaction rules like `Bearer` and `Basic` header scrubbing.
