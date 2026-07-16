## 2024-05-18 - Missing streaming caps on attachment fetching
**Vulnerability:** Memory exhaustion DoS risk in `fetch_attachment`. The code checked the `content-length` header to abort early, but if the server lied or omitted the header, the subsequent unbounded `await response.arrayBuffer()` could crash the process by trying to load a massive payload entirely into memory.
**Learning:** Checking headers is not enough; defensive size caps must be enforced at the stream reading level to protect against malicious servers.
**Prevention:** Always use the centralized `fetchWithCaps` helper for external fetches, as it reads chunks and aborts immediately when `maxBytes` is exceeded.
