## 2024-05-14 - Batch Schema Extraction
**Learning:** For database schema extraction, querying columns table-by-table in a loop can cause an N+1 query problem, making it slow. The MySQL driver was optimized to use a batched query (`IN (?, ?, ...)`), but `sqlserver.ts` is still using a loop.
**Action:** Optimize schema extraction in `sqlserver.ts` by using a single batched query to get columns for all tables, replacing the `for` loop over `tables` that executes a query for each.
## 2024-05-16 - SQLite batched schema query requires alias for [notnull]
**Learning:** When using SQLite's `pragma_table_info` function joined with `sqlite_master`, the `notnull` column is a reserved keyword in some contexts or causes syntax errors if accessed as `p.notnull as notnull`. We must escape it as `p.[notnull] as is_notnull` and use the alias.
**Action:** Use bracket escaping and a clear alias like `is_notnull` when selecting `notnull` from `pragma_table_info`.
