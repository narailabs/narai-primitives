# Task 9: Wire policy defaults + floor aspects

Lock in the connector's gating defaults: `policyFloorAspects: ["delete"]` (operator YAML cannot downgrade the delete aspect to `success`) and an explicit `defaultPolicy` so `admin: "denied"` is visible at the call site (no implicit reliance on the toolkit's `DEFAULT_POLICY`).

**Files:**
- Modify: `src/connectors/github/index.ts`
- Modify: `tests/connectors/github/integration/framework.test.ts` (new tests asserting the floor + default-policy)

- [ ] **Step 1: Write the failing tests**

Open `tests/connectors/github/integration/framework.test.ts` and append a new `describe` block before the existing `describe("--curate flag", ...)` block:

```ts
describe("policy defaults & floors", () => {
  it("rejects operator YAML setting policy.aspects.delete: success", () => {
    writeRepoPolicy(
      "policy:\n  aspects:\n    delete: success\n",
    );
    const c = buildGithubConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "ghp_test" }),
    });
    // The toolkit eagerly loads policy on first invocation; calling main()
    // with a benign action surfaces the load-error envelope.
    return c
      .main(["--action", "repo_info", "--params", '{"owner":"o","repo":"r"}'])
      .then((result) => {
        const parsed = JSON.parse(result.stdout);
        expect(parsed.status).toBe("error");
        expect(parsed.error.error_code).toBe("CONFIG_ERROR");
        expect(parsed.error.message).toMatch(/aspects.delete/);
      });
  });

  it("admin actions are denied under DEFAULT_POLICY (no operator config)", async () => {
    // No writeRepoPolicy call — falls through to the connector's defaultPolicy.
    const c = buildGithubConnector({
      sdk: async () =>
        makeClient({}, async () => jsonResponse({ sha: "x", merged: true })),
      credentials: async () => ({ token: "ghp_test" }),
    });
    const r = await c.main([
      "--action",
      "merge_pull_request",
      "--params",
      '{"owner":"o","repo":"r","pull_number":1,"merge_method":"merge"}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("denied");
    expect(parsed.reason).toMatch(/admin/);
  });

  it("write+delete aspect escalates by default (no operator config)", async () => {
    const c = buildGithubConnector({
      sdk: async () =>
        makeClient({}, async () =>
          jsonResponse({ number: 1, title: "t", state: "closed" }),
        ),
      credentials: async () => ({ token: "ghp_test" }),
    });
    const r = await c.main([
      "--action",
      "close_pull_request",
      "--params",
      '{"owner":"o","repo":"r","pull_number":1}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("escalate");
  });
});
```

- [ ] **Step 2: Run tests — confirm fail (or partially pass) before the wiring change**

```
npx vitest run tests/connectors/github/integration/framework.test.ts
```
Expected: at least one of the three new tests fails. The `aspects.delete` floor test will pass only after the wiring in Step 3. The admin-denied test may pass already because `DEFAULT_POLICY` already has `admin: "denied"`; we're just locking that in.

- [ ] **Step 3: Wire `policyFloorAspects` + explicit `defaultPolicy` in `index.ts`**

Inside `buildGithubConnector(...)`'s `createConnector<GithubClient>({...})` call, add the two lines:

```ts
  return createConnector<GithubClient>({
    name: "github",
    version: "3.0.1",                   // bumped to 4.0.0 in Task 13
    scope: githubScope,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    policyFloorAspects: ["delete"],
    defaultPolicy: {
      read: "success",
      write: "escalate",
      admin: "denied",
      aspects: { delete: "escalate" },
    },
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
      ...buildIssuesActions({ behavior }),
      ...buildCommentsActions({ behavior }),
      ...buildReleasesActions({ behavior }),
      ...buildWorkflowsActions({ behavior }),
    },
    mapError: mapHttpError(CODE_MAP),
  });
```

- [ ] **Step 4: Run tests — confirm all three new tests pass**

```
npx vitest run tests/connectors/github/integration/framework.test.ts
```
Expected: all passing.

- [ ] **Step 5: Run the full repo suite to catch unrelated breakage**

```
npm run typecheck && npm test
```
Expected: passes.

- [ ] **Step 6: Commit**

```
git add src/connectors/github/index.ts tests/connectors/github/integration/framework.test.ts
git commit -m "feat(github): policy floors — delete aspect + explicit defaultPolicy

policyFloorAspects: [\"delete\"] prevents operator YAML from setting
policy.aspects.delete to success (would slip every close_* and
delete_* call past the gate). defaultPolicy is now declared
explicitly on the connector so admin: denied is visible at the call
site rather than inheriting from the toolkit's DEFAULT_POLICY."
```
