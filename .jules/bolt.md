## 2026-05-18 - SQLite `pragma_table_info` performance

**Learning:** `pragma_table_info` is typically used via string interpolation `PRAGMA table_info(my_table)`, leading to an N+1 query pattern where statements must be prepared per table. A fully batched alternative joining `sqlite_master` with `pragma_table_info(m.name)` proved surprisingly slow because SQLite performs the join inefficiently compared to the JS loop overhead.
**Action:** `pragma_table_info(?)` *can* be prepared as a table-valued function. Using a single prepared `db.prepare("SELECT * FROM pragma_table_info(?)")` and iterating with `.all(tableName)` reduces statement preparation overhead and gives a reliable 20-25% speedup without the performance penalty of a full SQL join.
