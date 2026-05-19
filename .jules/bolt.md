## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.

## 2024-05-15 - SQLite Schema Extraction Compilation Overhead
**Learning:** For SQLite schema extraction using `better-sqlite3`, fully batched JOINs with `sqlite_master` are surprisingly slow compared to the JS loop overhead. However, executing `PRAGMA table_info(...)` using string interpolation inside a JS loop compiles the statement from scratch on every iteration (N+1 compilation problem).
**Action:** Use `pragma_table_info(?)` as a parameterized table-valued function within a single prepared statement before the loop (`const stmt = db.prepare("SELECT * FROM pragma_table_info(?)")`), and run `stmt.all(tableName)` in the loop to eliminate the N+1 compilation overhead while preserving the fast looping structure.
