## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.
## 2026-06-19 - Top-K Extraction Overhead
**Learning:** In usage metrics aggregation pipelines (e.g., `src/toolkit/usage/aggregate.ts`), extracting the top-K items via `[...array].sort().slice(0, K)` scales at O(N log N). On large datasets, this blocks the Node.js event loop unnecessarily when a simple O(N) traversal would suffice.
**Action:** Replace `sort().slice()` with an O(N) manual loop to track only the top K items when calculating `top_responses`, improving metrics aggregation speed.
