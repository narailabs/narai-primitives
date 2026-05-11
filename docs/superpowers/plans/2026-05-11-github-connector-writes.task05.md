# Task 5: Issue actions module (`actions/issues.ts`)

Add 4 client methods and 4 action specs covering `get_issue`, `create_issue`, `update_issue` (state=closed rejected at schema), and `close_issue` (write + delete aspect).

**Files:**
- Modify: `src/connectors/github/lib/github_client.ts` (add 4 methods + `GithubIssueDetail` type)
- Create: `src/connectors/github/actions/issues.ts`
- Modify: `src/connectors/github/index.ts` (spread `buildIssuesActions`)
- Create: `tests/connectors/github/unit/actions_issues.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/connectors/github/unit/actions_issues.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildIssuesActions } from "../../../../src/connectors/github/actions/issues.js";
import type { GithubClient } from "../../../../src/connectors/github/lib/github_client.js";

function fakeSdk(o: Partial<GithubClient> = {}): GithubClient {
  return o as unknown as GithubClient;
}
function runHandler<P>(
  spec: ActionSpec<P, GithubClient>,
  params: unknown,
  sdk: GithubClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

describe("buildIssuesActions — classification", () => {
  const actions = buildIssuesActions({ behavior: { requireDraftPr: false } });
  it("get_issue is read", () => {
    expect(actions["get_issue"]?.classify).toEqual({ kind: "read" });
  });
  it("create_issue is write", () => {
    expect(actions["create_issue"]?.classify).toEqual({ kind: "write" });
  });
  it("update_issue is write", () => {
    expect(actions["update_issue"]?.classify).toEqual({ kind: "write" });
  });
  it("close_issue is write + delete aspect", () => {
    expect(actions["close_issue"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

describe("get_issue", () => {
  it("maps to a normalized envelope", async () => {
    const sdk = fakeSdk({
      getIssue: async () => ({
        ok: true,
        status: 200,
        data: {
          number: 11,
          title: "bug: x",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: "bug" }, "p1"],
          html_url: "https://github.com/o/r/issues/11",
          body: "...",
          updated_at: "2026-05-01T00:00:00Z",
        },
      }),
    });
    const actions = buildIssuesActions({
      behavior: { requireDraftPr: false },
    });
    const r = (await runHandler(
      actions["get_issue"]!,
      { owner: "o", repo: "r", issue_number: 11 },
      sdk,
    )) as { number: number; author: string; labels: string[] };
    expect(r).toMatchObject({
      number: 11,
      author: "alice",
      labels: ["bug", "p1"],
    });
  });
});

describe("create_issue", () => {
  it("forwards title/body/labels/assignees", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createIssue: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            number: 12,
            title: "t",
            state: "open",
            html_url: "x",
            user: { login: "alice" },
          },
        };
      },
    });
    const actions = buildIssuesActions({
      behavior: { requireDraftPr: false },
    });
    const r = (await runHandler(
      actions["create_issue"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        body: "b",
        labels: ["bug"],
        assignees: ["alice"],
      },
      sdk,
    )) as { number: number };
    expect(r.number).toBe(12);
    expect(bodySent).toMatchObject({
      title: "t",
      body: "b",
      labels: ["bug"],
      assignees: ["alice"],
    });
  });
});

describe("update_issue — schema rejects state=closed", () => {
  const actions = buildIssuesActions({ behavior: { requireDraftPr: false } });
  it("accepts state=open", () => {
    expect(() =>
      actions["update_issue"]!.params.parse({
        owner: "o",
        repo: "r",
        issue_number: 1,
        state: "open",
      }),
    ).not.toThrow();
  });
  it("rejects state=closed", () => {
    expect(() =>
      actions["update_issue"]!.params.parse({
        owner: "o",
        repo: "r",
        issue_number: 1,
        state: "closed",
      }),
    ).toThrow(/close_issue/);
  });
});

describe("close_issue", () => {
  it("returns closed envelope and accepts state_reason", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      closeIssue: async (_o, _r, _n, body) => {
        bodySent = body ?? {};
        return {
          ok: true,
          status: 200,
          data: {
            number: 11,
            title: "t",
            state: "closed",
            html_url: "x",
            user: { login: "alice" },
          },
        };
      },
    });
    const actions = buildIssuesActions({
      behavior: { requireDraftPr: false },
    });
    const r = (await runHandler(
      actions["close_issue"]!,
      {
        owner: "o",
        repo: "r",
        issue_number: 11,
        state_reason: "completed",
      },
      sdk,
    )) as { closed: boolean; state: string };
    expect(r).toMatchObject({ closed: true, state: "closed" });
    expect(bodySent["state_reason"]).toBe("completed");
  });
});
```

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/connectors/github/unit/actions_issues.test.ts
```
Expected: fail (module not found).

- [ ] **Step 3: Add the 4 client methods to `lib/github_client.ts`**

Append inside the `GithubClient` class:

```ts
  // ─── issues ─────────────────────────────────────────────────────────────
  public async getIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GithubResult<GithubIssueDetail>> {
    return this._http.request<GithubIssueDetail>(
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
    );
  }

  public async createIssue(
    owner: string,
    repo: string,
    body: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      milestone?: number;
    },
  ): Promise<GithubResult<GithubIssueDetail>> {
    return this._http.request<GithubIssueDetail>(
      "POST",
      `/repos/${owner}/${repo}/issues`,
      { body },
    );
  }

  public async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body: {
      title?: string;
      body?: string;
      state?: "open";
      labels?: string[];
      assignees?: string[];
      milestone?: number | null;
    },
  ): Promise<GithubResult<GithubIssueDetail>> {
    return this._http.request<GithubIssueDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      { body },
    );
  }

  public async closeIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body?: { state_reason?: "completed" | "not_planned" | "reopened" | null },
  ): Promise<GithubResult<GithubIssueDetail>> {
    const payload: { state: "closed"; state_reason?: string | null } = {
      state: "closed",
    };
    if (body?.state_reason !== undefined)
      payload.state_reason = body.state_reason;
    return this._http.request<GithubIssueDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      { body: payload },
    );
  }
```

Add type `GithubIssueDetail` near the existing `GithubIssue` interface:

```ts
export interface GithubIssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  user?: { login: string };
  labels?: Array<string | { name?: string }>;
  html_url?: string;
  body?: string;
  updated_at?: string;
  state_reason?: string | null;
  assignees?: Array<{ login: string }>;
}
```

- [ ] **Step 4: Create `actions/issues.ts`**

```ts
/**
 * Issue action specs: get / create / update / close.
 * Close is a dedicated action carrying the delete aspect so the toolkit
 * policy gate's `aspects.delete` rule applies. update_issue's zod schema
 * forbids state=closed at parse-time to route closures through close_issue.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const ownerRepoField = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/, "owner/repo: alphanumeric, dots, dashes, underscores only");
const issueNumberField = z.coerce.number().int().positive();

const getIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
});

const createIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().int().positive().optional(),
});

const updateIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  state: z
    .enum(["open"], {
      errorMap: () => ({
        message:
          "update_issue only accepts state=open. Use close_issue to close.",
      }),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
});

const closeIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
  state_reason: z
    .enum(["completed", "not_planned", "reopened"])
    .optional(),
});

function issueEnvelope(d: {
  number: number;
  title: string;
  state: "open" | "closed";
  user?: { login: string };
  labels?: Array<string | { name?: string }>;
  html_url?: string;
  body?: string;
  updated_at?: string;
  state_reason?: string | null;
}) {
  return {
    number: d.number,
    title: d.title,
    state: d.state,
    author: d.user?.login ?? "",
    labels: (d.labels ?? []).map((l) =>
      typeof l === "string" ? l : l.name ?? "",
    ),
    url: d.html_url ?? "",
    body_markdown: d.body ?? "",
    updated_at: d.updated_at ?? null,
    state_reason: d.state_reason ?? null,
  };
}

export function buildIssuesActions(_deps: GithubActionDeps): GithubActions {
  return {
    get_issue: {
      description: "Fetch a single issue by number",
      params: getIssueParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.getIssue(p.owner, p.repo, p.issue_number);
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },
    create_issue: {
      description: "Create a new issue",
      params: createIssueParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title: string;
          body?: string;
          labels?: string[];
          assignees?: string[];
          milestone?: number;
        } = { title: p.title };
        if (p.body !== undefined) body.body = p.body;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.assignees !== undefined) body.assignees = p.assignees;
        if (p.milestone !== undefined) body.milestone = p.milestone;
        const r = await ctx.sdk.createIssue(p.owner, p.repo, body);
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },
    update_issue: {
      description:
        "Update title, body, labels, assignees, or set state=open (reopen). Closing is a separate action.",
      params: updateIssueParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title?: string;
          body?: string;
          state?: "open";
          labels?: string[];
          assignees?: string[];
        } = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.body !== undefined) body.body = p.body;
        if (p.state !== undefined) body.state = p.state;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.assignees !== undefined) body.assignees = p.assignees;
        const r = await ctx.sdk.updateIssue(
          p.owner,
          p.repo,
          p.issue_number,
          body,
        );
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },
    close_issue: {
      description: "Close an issue (does not delete; REST has no hard-delete).",
      params: closeIssueParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const body: { state_reason?: "completed" | "not_planned" | "reopened" } = {};
        if (p.state_reason !== undefined) body.state_reason = p.state_reason;
        const r = await ctx.sdk.closeIssue(
          p.owner,
          p.repo,
          p.issue_number,
          body,
        );
        throwIfHttpError(r);
        return {
          ...issueEnvelope(r.data),
          closed: true,
        };
      },
    },
  };
}
```

- [ ] **Step 5: Wire into `index.ts`**

In `src/connectors/github/index.ts`:

```ts
import { buildIssuesActions } from "./actions/issues.js";
```

```ts
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
      ...buildIssuesActions({ behavior }),
    },
```

- [ ] **Step 6: Run tests**

```
npx vitest run tests/connectors/github/unit/actions_issues.test.ts
```
Expected: all passing.

- [ ] **Step 7: Add 4 client-method assertions to `github_client_mutations.test.ts`**

Append:

```ts
describe("GithubClient — issue methods", () => {
  it("getIssue issues GET /issues/{n}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t", state: "open" });
    });
    const r = await client.getIssue("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("GET");
    expect(observed.url).toMatch(/\/repos\/o\/r\/issues\/1$/);
  });
  it("createIssue issues POST /issues", async () => {
    let bodySent = "";
    const client = makeClient(async (_url, init) => {
      bodySent = String(init?.body ?? "");
      return jsonResponse({ number: 2, title: "t", state: "open" });
    });
    const r = await client.createIssue("o", "r", { title: "t" });
    expect(r.ok).toBe(true);
    expect(bodySent).toContain('"title":"t"');
  });
  it("updateIssue issues PATCH /issues/{n}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t2", state: "open" });
    });
    const r = await client.updateIssue("o", "r", 1, { title: "t2" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
  });
  it("closeIssue issues PATCH with state=closed", async () => {
    let bodySent = "";
    const client = makeClient(async (_url, init) => {
      bodySent = String(init?.body ?? "");
      return jsonResponse({ number: 1, title: "t", state: "closed" });
    });
    const r = await client.closeIssue("o", "r", 1, {
      state_reason: "completed",
    });
    expect(r.ok).toBe(true);
    expect(bodySent).toContain('"state":"closed"');
    expect(bodySent).toContain('"state_reason":"completed"');
  });
});
```

- [ ] **Step 8: Run all github tests and full suite**

```
npx vitest run tests/connectors/github && npm run typecheck
```
Expected: all passing.

- [ ] **Step 9: Commit**

```
git add src/connectors/github/lib/github_client.ts src/connectors/github/actions/issues.ts src/connectors/github/index.ts tests/connectors/github/unit/actions_issues.test.ts tests/connectors/github/unit/github_client_mutations.test.ts
git commit -m "feat(github): issue actions (get/create/update/close)

Adds 4 issue actions following the same kind-and-aspect pattern as
PR actions. update_issue rejects state=closed at the zod schema; the
dedicated close_issue carries the delete aspect and accepts optional
state_reason (completed / not_planned / reopened)."
```
