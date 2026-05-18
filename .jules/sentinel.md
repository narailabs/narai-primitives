## 2026-05-18 - Authorization Header Leakage in Audit Logs
**Vulnerability:** Authorization headers (like `Authorization: Bearer <token>`) were not being redacted in the audit logging functions `scrubSecrets` and `scrubSqlSecrets`.
**Learning:** The existing redaction logic only looked for key-value pair assignments (like `password='...'`), missing HTTP header formats entirely.
**Prevention:** Future redaction functions should proactively identify HTTP authorization schemes as well as URL-based secrets and key-value pairs.
