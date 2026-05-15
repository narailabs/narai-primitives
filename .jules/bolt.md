## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2024-05-15 - SQLite Schema Extraction N+1 Query Problem
**Learning:** In the SQLite driver (`src/connectors/db/lib/drivers/sqlite.ts`), fetching schema metadata using `PRAGMA table_info()` inside a loop over tables creates an N+1 query bottleneck. `better-sqlite3` supports `JOIN pragma_table_info(...)` allowing extraction of column metadata for all tables in a single query.
**Action:** Always use table-valued functions joined with `sqlite_master` in SQLite instead of executing individual pragma queries in loops.
