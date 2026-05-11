# Task 10: CLI happy-path tests for new domains

Add one happy-path CLI invocation per new domain to `tests/connectors/github/unit/cli.test.ts`. This locks in CLI envelope round-tripping for the new action surface.

**Files:**
- Modify: `tests/connectors/github/unit/cli.test.ts`

- [ ] **Step 1: Read the existing pattern**

Open `tests/connectors/github/unit/cli.test.ts`. The file already contains a helper `makeConnector(client)` that constructs the connector via `buildGithubConnector({ sdk, credentials })`. Each existing test calls `c.main(["--action", "...", "--params", '...'])` and parses `result.stdout` as JSON. Reuse the helpers as-is.

- [ ] **Step 2: Append new tests**

Append the following `describe` block to the end of `cli.test.ts`:

```ts
describe("CLI happy-path — new write domains", () => {
  it("create_pull_request returns a pr_envelope JSON", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        number: 7,
        title: "t",
        state: "open",
        draft: false,
        user: { login: "alice" },
        base: { ref: "main", sha: "b0" },
        head: { ref: "feat/x", sha: "h0" },
        html_url: "u",
      }),
    );
    const c = makeConnector(client);
    const r = await c.main([
      "--action",
      "create_pull_request",
      "--params",
      '{"owner":"o","repo":"r","title":"t","head":"feat/x","base":"main"}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.data.number).toBe(7);
  });

  it("create_issue returns an issue envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        number: 9,
        title: "t",
        state: "open",
        user: { login: "alice" },
        labels: [],
      }),
    );
    const c = makeConnector(client);
    const r = await c.main([
      "--action",
      "create_issue",
      "--params",
      '{"owner":"o","repo":"r","title":"t"}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.data.number).toBe(9);
  });

  it("add_issue_comment returns a comment envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        id: 42,
        user: { login: "alice" },
        body: "hi",
        html_url: "u",
        created_at: "2026-05-01T00:00:00Z",
      }),
    );
    const c = makeConnector(client);
    const r = await c.main([
      "--action",
      "add_issue_comment",
      "--params",
      '{"owner":"o","repo":"r","issue_number":1,"body":"hi"}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.data.comment_id).toBe(42);
  });

  it("create_release returns a release envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        id: 500,
        tag_name: "v1.0.0",
        name: "1.0",
        draft: true,
        prerelease: false,
        html_url: "u",
      }),
    );
    const c = makeConnector(client);
    const r = await c.main([
      "--action",
      "create_release",
      "--params",
      '{"owner":"o","repo":"r","tag_name":"v1.0.0","draft":true}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.data.release_id).toBe(500);
  });

  it("trigger_workflow_dispatch returns triggered=true", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 204 }));
    const c = makeConnector(client);
    const r = await c.main([
      "--action",
      "trigger_workflow_dispatch",
      "--params",
      '{"owner":"o","repo":"r","workflow_id_or_filename":"ci.yml","ref":"main"}',
    ]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.data.triggered).toBe(true);
  });
});
```

- [ ] **Step 3: Run the CLI tests**

```
npx vitest run tests/connectors/github/unit/cli.test.ts
```
Expected: existing tests pass, plus the 5 new CLI happy-path tests.

Note: write actions normally escalate under the connector's `defaultPolicy.write: "escalate"`. The test harness here uses the CLI surface; the existing tests in this file rely on the connector's `--approve` flag or the framework's auto-approval. If the new tests come back with `parsed.status === "escalate"` instead of `"success"`, add `--approve` between the action and the params:

```ts
    const r = await c.main([
      "--action",
      "create_pull_request",
      "--approve",
      "--params",
      '{"owner":"o","repo":"r","title":"t","head":"feat/x","base":"main"}',
    ]);
```

Re-run to confirm.

- [ ] **Step 4: Commit**

```
git add tests/connectors/github/unit/cli.test.ts
git commit -m "test(github): CLI happy-path coverage for the 5 new write domains

One create_* invocation per new domain (PR, issue, comment, release,
workflow_dispatch). Locks in the CLI envelope shape after the action
modules were split out."
```
