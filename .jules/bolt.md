## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.
## 2024-06-14 - Top-K Extraction using O(N log N) Array.sort is an anti-pattern for usage metrics
**Learning:** Using `[...records].sort().slice(0, K)` is extremely inefficient for top-K extraction in large data arrays like usage logging or metrics, as it processes O(N log N) rather than O(N). When N scales (e.g. 100,000 requests in a session), this significantly blocks the Node.js event loop (~350ms vs ~10ms for O(N)).
**Action:** When extracting top K items (especially small K like 3) from an unbounded collection, use manual loop tracking or a priority queue for an O(N) complexity to avoid performance bottlenecks.
