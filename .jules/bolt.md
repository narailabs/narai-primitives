## 2024-11-13 - O(N log N) Set Sorting Bottlenecks
**Learning:** Sequential string parsing inherently yields sorted index values. Storing these indices in a `Set` for deduplication and then converting to an array to sort them (`Array.from(b1).sort((a,b) => a-b)`) introduces unnecessary O(N log N) overhead and type conversion overhead.
**Action:** When tracking index positions during sequential parsing, use a standard array `number[]` populated sequentially via `push()` to avoid redundant sorting logic and improve performance.
