## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.
## 2026-06-09 - DynamoDB Schema Fetch Parallelization
**Learning:** In the DynamoDB driver, sequential `DescribeTableCommand` calls for schema extraction over many tables causes a large N+1 network latency penalty. We don't have access to concurrency limitation packages like `p-limit`.
**Action:** Implemented manual chunking of the queries (chunk size 10) with `Promise.all` to safely parallelize the network calls and significantly reduce execution time while avoiding AWS API throttling errors.
