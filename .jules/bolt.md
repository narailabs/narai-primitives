## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.
## 2024-05-30 - DynamoDB Schema Extraction Concurrency
**Learning:** For DynamoDB schema extraction, looping over tables sequentially and awaiting `DescribeTableCommand` causes an N+1 problem that blocks on network latency for each table.
**Action:** Optimize schema extraction in `dynamodb.ts` by fetching table definitions concurrently using `Promise.all` with a chunked concurrency limit (e.g., 10) to parallelize network calls while avoiding AWS API throttling.
