## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.
## 2024-05-24 - DynamoDB Concurrent Schema Extraction
**Learning:** DynamoDB's schema extraction suffered from an N+1 network latency problem because `DescribeTableCommand` was called sequentially for each table in a loop. Because DynamoDB API is HTTP-based, this linearly scaled latency with the number of tables.
**Action:** Replaced sequential loop with chunked concurrent requests using `Promise.all` with a chunk size of 10. This bounds the latency by parallelizing network calls while avoiding AWS API rate throttling.
