## 2024-06-25 - Avoid array sort for Top-K in hot paths
**Learning:** V8 engine sorting (`[...arr].sort()`) is surprisingly slow and blocks the event loop for thousands of records when fetching Top-K elements (e.g. usage statistics). It scales at O(N log N) when O(N) is sufficient for a fixed K.
**Action:** When gathering top elements from a large data array in this codebase, manually track the top items in a single O(N) pass rather than sorting a full copy.
