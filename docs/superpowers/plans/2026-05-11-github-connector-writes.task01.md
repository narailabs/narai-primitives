# Task 1: Expand HttpClient allowedMethods on the GitHub client

**Files:**
- Modify: `src/connectors/github/lib/github_client.ts:62` (the `allowedMethods` line inside the constructor's `new HttpClient({...})` call)
- Test: `tests/connectors/github/unit/github_client_mutations.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `tests/connectors/github/unit/github_client_mutations.test.ts` with:

```ts
/**
 * Locks in that the GitHub HTTP surface permits the write-method set
 * needed for PRs, issues, comments, releases, and workflows: GET, POST,
 * PATCH, PUT, DELETE. Each test sends a request via a method that was
 * previously not in `allowedMethods` and asserts the request reaches the
 * fake fetch (i.e., the client did NOT short-circuit with
 * `METHOD_NOT_ALLOWED`).
 */
import { describe, expect, it } from "vitest";
import {
  GithubClient,
  type GithubClientOptions,
} from "../../../../src/connectors/github/lib/github_client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  fetchMock: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<GithubClientOptions> = {},
): GithubClient {
  return new GithubClient({
    token: "ghp_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url, init) => fetchMock(String(url), init),
    sleepImpl: async () => {},
    ...overrides,
  });
}

describe("GithubClient — allowedMethods baseline (GET + POST)", () => {
  it("GET is allowed (getRepo reaches the fake fetch)", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ full_name: "a/b" });
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("GET");
  });

  it("POST is allowed (graphql reaches the fake fetch)", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ data: { __typename: "Query" } });
    });
    const r = await client.graphql<{ __typename: string }>(
      "query { __typename }",
      {},
    );
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("POST");
  });
});
```

- [ ] **Step 2: Run test to verify it passes for current state**

Run:
```
npx vitest run tests/connectors/github/unit/github_client_mutations.test.ts
```
Expected: 2 passing. (The test is initially scoped to behaviors that don't yet depend on Task 1's expansion — it locks in the GET + POST baseline. The new verbs are added next.)

- [ ] **Step 3: Add the failing assertions for PATCH / PUT / DELETE**

Append the following three tests inside the same `describe` block:

```ts
  it("PATCH is permitted by allowedMethods", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ ok: true });
    });
    const r = await (client as unknown as {
      _http: {
        request: (m: string, p: string, o?: unknown) => Promise<{ ok: boolean; code?: string }>;
      };
    })._http.request("PATCH", "/repos/a/b/issues/1", { body: { title: "x" } });
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("PATCH");
  });

  it("PUT is permitted by allowedMethods", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ ok: true });
    });
    const r = await (client as unknown as {
      _http: {
        request: (m: string, p: string, o?: unknown) => Promise<{ ok: boolean; code?: string }>;
      };
    })._http.request("PUT", "/repos/a/b/pulls/1/merge", { body: { merge_method: "squash" } });
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("PUT");
  });

  it("DELETE is permitted by allowedMethods", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({}, 204);
    });
    const r = await (client as unknown as {
      _http: {
        request: (m: string, p: string, o?: unknown) => Promise<{ ok: boolean; code?: string }>;
      };
    })._http.request("DELETE", "/repos/a/b/issues/comments/1");
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("DELETE");
  });
```

- [ ] **Step 4: Run tests — confirm the three new tests fail**

Run:
```
npx vitest run tests/connectors/github/unit/github_client_mutations.test.ts
```
Expected: 2 passing, 3 failing. Each failure says `r.ok` was `false` with `code: "METHOD_NOT_ALLOWED"`.

- [ ] **Step 5: Expand allowedMethods**

Open `src/connectors/github/lib/github_client.ts`. Find the constructor (starts around line 55, contains `new HttpClient({...})`). Replace:

```ts
      allowedMethods: new Set(["GET", "POST"]),
```

with:

```ts
      allowedMethods: new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]),
```

- [ ] **Step 6: Run tests — confirm all 5 pass**

Run:
```
npx vitest run tests/connectors/github/unit/github_client_mutations.test.ts
```
Expected: 5 passing.

- [ ] **Step 7: Run the full github test directory to confirm no regressions**

Run:
```
npx vitest run tests/connectors/github
```
Expected: all existing tests still pass, plus the 5 new ones.

- [ ] **Step 8: Commit**

```
git add src/connectors/github/lib/github_client.ts tests/connectors/github/unit/github_client_mutations.test.ts
git commit -m "feat(github): permit PATCH/PUT/DELETE on the HTTP surface

Expands GithubClient's HttpClient allowedMethods from {GET, POST} to
{GET, POST, PATCH, PUT, DELETE}. Locked in by tests in
github_client_mutations.test.ts. Foundation for the upcoming write
actions (PRs, issues, comments, releases, workflows)."
```
