## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.

## 2024-05-14 - Batch DynamoDB Schema Extraction
**Learning:** For DynamoDB schema extraction, executing `DescribeTableCommand` sequentially in a `for` loop for every table results in an $O(N)$ N+1 query problem, making it slow. However, blindly using `Promise.all` for all tables concurrently can trigger AWS API throttling limits.
**Action:** Optimize schema extraction in `dynamodb.ts` by batching `DescribeTableCommand` calls using a chunked approach (e.g., `concurrencyLimit = 10`) and awaiting each chunk with `Promise.all`, letting exceptions bubble up rather than swallowing them.
