## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.

## 2026-06-24 - O(N) Top-K Extraction for Usage Metrics
**Learning:** Using `[...records].sort().slice(0, K)` for Top-K extraction can cause an O(N log N) bottleneck on large arrays, which blocks the Node.js event loop during usage metrics aggregation.
**Action:** Replaced the sort with an O(N) manual tracking loop to keep the Top-3 elements, avoiding allocating a full copy and executing a full sort for only a small subset.
