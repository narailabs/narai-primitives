## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2024-05-24 - Batch DynamoDB DescribeTable
**Learning:** For DynamoDB schema extraction, running `DescribeTable` for each table sequentially inside a loop can be a performance bottleneck (N network round-trips).
**Action:** Use chunked `Promise.all` to parallelize the requests while preventing AWS API throttling.
