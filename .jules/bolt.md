## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2026-05-23 - SQL Server Schema Batch Optimization
**Learning:** When querying INFORMATION_SCHEMA.COLUMNS, chunking IN (@table...) parameters to respect SQL Server's 2100 limit is unnecessary and inefficient. It's better to avoid passing the list of tables entirely by doing a JOIN with INFORMATION_SCHEMA.TABLES and applying the same filter directly.
**Action:** Remove the chunking loop and use a JOIN to extract metadata for all relevant tables in a single DB query, simplifying logic and reducing compilation and network overhead.
## 2026-05-25 - DynamoDB Schema Parallel Extraction
**Learning:** Sequential network calls per table in DynamoDB schema extraction cause high latency (O(N) network round-trips). Unlike relational DBs that can JOIN metadata tables, DynamoDB requires one HTTP request per table.
**Action:** Optimize DynamoDB schema extraction by sending `DescribeTableCommand` requests concurrently using `Promise.all`, but chunked (e.g. 10 at a time) to prevent AWS API throttling.
## 2024-06-25 - Avoid array sort for Top-K in hot paths
**Learning:** V8 engine sorting (`[...arr].sort()`) is surprisingly slow and blocks the event loop for thousands of records when fetching Top-K elements (e.g. usage statistics). It scales at O(N log N) when O(N) is sufficient for a fixed K.
**Action:** When gathering top elements from a large data array in this codebase, manually track the top items in a single O(N) pass rather than sorting a full copy.
## 2026-09-13 - Avoid O(N log N) sorting for monotonically increasing sets
**Learning:** When tracking index positions during string parsing or iteration (e.g., finding boundaries), using a `Set` instead of an array causes an issue if you later convert it to an array and sort it (`Array.from(set).sort()`). Because the loop naturally encounters indices sequentially, an array naturally stores them monotonically increasing, avoiding unnecessary O(N log N) sort overhead.
**Action:** When parsing strings or iterating sequentially to find indices, use standard arrays (`push`) rather than `Set`s that require subsequent conversion and sorting.
