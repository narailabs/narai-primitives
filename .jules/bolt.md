## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2024-06-25 - SQLite schema extraction N+1 compilation
**Learning:** In the better-sqlite3 driver, calling db.prepare("PRAGMA table_info(...)") inside a loop over tables incurs significant compilation overhead. better-sqlite3 treats pragma_table_info(?) as a table-valued function which allows for a single prepared statement.
**Action:** Always extract SQLite table info with a single prepared statement `const stmt = db.prepare('SELECT * FROM pragma_table_info(?)')` outside of any loops to avoid N+1 query compilation overhead.
