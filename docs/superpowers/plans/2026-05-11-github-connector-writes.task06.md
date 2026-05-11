# Task 6: Comment actions module (`actions/comments.ts`)

Add 6 client methods and 6 action specs covering issue-conversation comments (add/update/delete) and PR review-inline comments (add/update/delete).

**Files:**
- Modify: `src/connectors/github/lib/github_client.ts` (add 6 methods)
- Create: `src/connectors/github/actions/comments.ts`
- Modify: `src/connectors/github/index.ts` (spread `buildCommentsActions`)
- Create: `tests/connectors/github/unit/actions_comments.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/connectors/github/unit/actions_comments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildCommentsActions } from "../../../../src/connectors/github/actions/comments.js";
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

describe("buildCommentsActions — classification", () => {
  const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
  it("add_issue_comment is write", () => {
    expect(a["add_issue_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("update_issue_comment is write", () => {
    expect(a["update_issue_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("delete_issue_comment is write + delete aspect", () => {
    expect(a["delete_issue_comment"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
  it("add_pr_review_comment is write", () => {
    expect(a["add_pr_review_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("update_pr_review_comment is write", () => {
    expect(a["update_pr_review_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("delete_pr_review_comment is write + delete aspect", () => {
    expect(a["delete_pr_review_comment"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

describe("add_issue_comment", () => {
  it("posts the body and returns envelope", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      addIssueComment: async (_o, _r, _n, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            id: 99,
            user: { login: "alice" },
            body: "hello",
            html_url: "x",
            created_at: "2026-05-01T00:00:00Z",
          },
        };
      },
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["add_issue_comment"]!,
      { owner: "o", repo: "r", issue_number: 1, body: "hello" },
      sdk,
    )) as { comment_id: number; body_markdown: string };
    expect(bodySent["body"]).toBe("hello");
    expect(r).toMatchObject({ comment_id: 99, body_markdown: "hello" });
  });
});

describe("update_issue_comment", () => {
  it("patches the comment by id", async () => {
    const sdk = fakeSdk({
      updateIssueComment: async (_o, _r, _id, body) => ({
        ok: true,
        status: 200,
        data: {
          id: 99,
          user: { login: "alice" },
          body: body.body,
          html_url: "x",
          created_at: "x",
          updated_at: "y",
        },
      }),
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["update_issue_comment"]!,
      { owner: "o", repo: "r", comment_id: 99, body: "edited" },
      sdk,
    )) as { body_markdown: string };
    expect(r.body_markdown).toBe("edited");
  });
});

describe("delete_issue_comment", () => {
  it("returns { deleted: true } on 204", async () => {
    let called = false;
    const sdk = fakeSdk({
      deleteIssueComment: async () => {
        called = true;
        return { ok: true, status: 204, data: undefined as unknown };
      },
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["delete_issue_comment"]!,
      { owner: "o", repo: "r", comment_id: 99 },
      sdk,
    )) as { comment_id: number; deleted: boolean };
    expect(called).toBe(true);
    expect(r).toMatchObject({ comment_id: 99, deleted: true });
  });
});

describe("add_pr_review_comment", () => {
  it("requires commit_id, path, line in schema", () => {
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    expect(() =>
      a["add_pr_review_comment"]!.params.parse({
        owner: "o",
        repo: "r",
        pr_number: 1,
        body: "x",
        commit_id: "deadbeef",
        path: "src/x.ts",
        line: 10,
      }),
    ).not.toThrow();
    expect(() =>
      a["add_pr_review_comment"]!.params.parse({
        owner: "o",
        repo: "r",
        pr_number: 1,
        body: "x",
      }),
    ).toThrow();
  });
});

describe("delete_pr_review_comment", () => {
  it("returns { deleted: true } on 204", async () => {
    const sdk = fakeSdk({
      deletePrReviewComment: async () => ({
        ok: true,
        status: 204,
        data: undefined as unknown,
      }),
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["delete_pr_review_comment"]!,
      { owner: "o", repo: "r", comment_id: 12 },
      sdk,
    )) as { deleted: boolean };
    expect(r.deleted).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/connectors/github/unit/actions_comments.test.ts
```
Expected: fail (module not found).

- [ ] **Step 3: Add the 6 client methods**

Append inside the `GithubClient` class in `src/connectors/github/lib/github_client.ts`:

```ts
  // ─── comments — issue-conversation ──────────────────────────────────────
  public async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: { body: string },
  ): Promise<GithubResult<GithubRawIssueComment>> {
    return this._http.request<GithubRawIssueComment>(
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
    );
  }
  public async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: { body: string },
  ): Promise<GithubResult<GithubRawIssueComment>> {
    return this._http.request<GithubRawIssueComment>(
      "PATCH",
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { body },
    );
  }
  public async deleteIssueComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    );
  }

  // ─── comments — PR review-inline ────────────────────────────────────────
  public async addPrReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: {
      body: string;
      commit_id: string;
      path: string;
      line: number;
      side?: "LEFT" | "RIGHT";
      start_line?: number;
      start_side?: "LEFT" | "RIGHT";
    },
  ): Promise<GithubResult<GithubRawPullReviewComment>> {
    return this._http.request<GithubRawPullReviewComment>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      { body },
    );
  }
  public async updatePrReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    body: { body: string },
  ): Promise<GithubResult<GithubRawPullReviewComment>> {
    return this._http.request<GithubRawPullReviewComment>(
      "PATCH",
      `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
      { body },
    );
  }
  public async deletePrReviewComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
    );
  }
```

- [ ] **Step 4: Create `actions/comments.ts`**

```ts
/**
 * Comment action specs — six actions across two distinct APIs:
 *  - Issue-conversation comments: top-level threaded comments on issues
 *    (also visible on PRs as "conversation" tab).
 *  - PR review-inline comments: file-and-line anchored comments on a PR.
 *
 * Delete actions carry the delete aspect.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const ownerRepoField = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/, "owner/repo: alphanumeric, dots, dashes, underscores only");
const numberField = z.coerce.number().int().positive();
const shaField = z.string().regex(/^[a-f0-9]{7,40}$/, "Expected a git SHA");
const pathField = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_./ -]+$/)
  .refine((p) => !p.includes(".."), { message: "Path traversal not allowed" });

const addIssueCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: numberField,
  body: z.string().min(1),
});
const updateIssueCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: numberField,
  body: z.string().min(1),
});
const deleteIssueCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: numberField,
});

const addPrReviewCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pr_number: numberField,
  body: z.string().min(1),
  commit_id: shaField,
  path: pathField,
  line: z.coerce.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  start_line: z.coerce.number().int().positive().optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
});
const updatePrReviewCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: numberField,
  body: z.string().min(1),
});
const deletePrReviewCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: numberField,
});

function issueCommentEnvelope(c: {
  id: number;
  user?: { login: string };
  body?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}) {
  return {
    comment_id: c.id,
    author: c.user?.login ?? "",
    body_markdown: c.body ?? "",
    url: c.html_url ?? "",
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
  };
}

function prReviewCommentEnvelope(c: {
  id: number;
  user?: { login: string };
  body?: string;
  path?: string;
  line?: number;
  commit_id?: string;
  diff_hunk?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}) {
  return {
    comment_id: c.id,
    author: c.user?.login ?? "",
    body_markdown: c.body ?? "",
    path: c.path ?? "",
    line: c.line ?? null,
    commit_id: c.commit_id ?? "",
    diff_hunk: c.diff_hunk ?? "",
    url: c.html_url ?? "",
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
  };
}

export function buildCommentsActions(_deps: GithubActionDeps): GithubActions {
  return {
    add_issue_comment: {
      description: "Add a comment on an issue or PR conversation",
      params: addIssueCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.addIssueComment(
          p.owner,
          p.repo,
          p.issue_number,
          { body: p.body },
        );
        throwIfHttpError(r);
        return issueCommentEnvelope(r.data);
      },
    },
    update_issue_comment: {
      description: "Edit an existing issue/PR-conversation comment",
      params: updateIssueCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.updateIssueComment(
          p.owner,
          p.repo,
          p.comment_id,
          { body: p.body },
        );
        throwIfHttpError(r);
        return issueCommentEnvelope(r.data);
      },
    },
    delete_issue_comment: {
      description: "Delete an issue/PR-conversation comment",
      params: deleteIssueCommentParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deleteIssueComment(
          p.owner,
          p.repo,
          p.comment_id,
        );
        throwIfHttpError(r);
        return { comment_id: p.comment_id, deleted: true };
      },
    },
    add_pr_review_comment: {
      description:
        "Add an inline review comment to a PR at a specific file/line/commit",
      params: addPrReviewCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          body: string;
          commit_id: string;
          path: string;
          line: number;
          side?: "LEFT" | "RIGHT";
          start_line?: number;
          start_side?: "LEFT" | "RIGHT";
        } = {
          body: p.body,
          commit_id: p.commit_id,
          path: p.path,
          line: p.line,
        };
        if (p.side !== undefined) body.side = p.side;
        if (p.start_line !== undefined) body.start_line = p.start_line;
        if (p.start_side !== undefined) body.start_side = p.start_side;
        const r = await ctx.sdk.addPrReviewComment(
          p.owner,
          p.repo,
          p.pr_number,
          body,
        );
        throwIfHttpError(r);
        return prReviewCommentEnvelope(r.data);
      },
    },
    update_pr_review_comment: {
      description: "Edit an existing PR review-inline comment",
      params: updatePrReviewCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.updatePrReviewComment(
          p.owner,
          p.repo,
          p.comment_id,
          { body: p.body },
        );
        throwIfHttpError(r);
        return prReviewCommentEnvelope(r.data);
      },
    },
    delete_pr_review_comment: {
      description: "Delete a PR review-inline comment",
      params: deletePrReviewCommentParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deletePrReviewComment(
          p.owner,
          p.repo,
          p.comment_id,
        );
        throwIfHttpError(r);
        return { comment_id: p.comment_id, deleted: true };
      },
    },
  };
}
```

- [ ] **Step 5: Wire into `index.ts`**

```ts
import { buildCommentsActions } from "./actions/comments.js";
```

```ts
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
      ...buildIssuesActions({ behavior }),
      ...buildCommentsActions({ behavior }),
    },
```

- [ ] **Step 6: Run tests**

```
npx vitest run tests/connectors/github/unit/actions_comments.test.ts
```
Expected: all passing.

- [ ] **Step 7: Append client-method tests to `github_client_mutations.test.ts`**

```ts
describe("GithubClient — comment methods", () => {
  it("addIssueComment POSTs to /issues/{n}/comments", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, user: { login: "a" }, body: "x" });
    });
    const r = await client.addIssueComment("o", "r", 9, { body: "x" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("POST");
    expect(observed.url).toMatch(/\/repos\/o\/r\/issues\/9\/comments$/);
  });
  it("updateIssueComment PATCHes /issues/comments/{id}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, user: { login: "a" }, body: "y" });
    });
    const r = await client.updateIssueComment("o", "r", 1, { body: "y" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
    expect(observed.url).toMatch(/\/repos\/o\/r\/issues\/comments\/1$/);
  });
  it("deleteIssueComment DELETEs /issues/comments/{id}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({}, 204);
    });
    const r = await client.deleteIssueComment("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("DELETE");
  });
  it("addPrReviewComment POSTs to /pulls/{n}/comments", async () => {
    let observedBody = "";
    const client = makeClient(async (_url, init) => {
      observedBody = String(init?.body ?? "");
      return jsonResponse({ id: 1, user: { login: "a" }, body: "x", path: "p", line: 1 });
    });
    const r = await client.addPrReviewComment("o", "r", 9, {
      body: "x",
      commit_id: "abcdef0",
      path: "p",
      line: 1,
    });
    expect(r.ok).toBe(true);
    expect(observedBody).toContain('"commit_id":"abcdef0"');
  });
  it("updatePrReviewComment PATCHes /pulls/comments/{id}", async () => {
    let observed = { method: "" };
    const client = makeClient(async (_url, init) => {
      observed = { method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, user: { login: "a" }, body: "y", path: "p", line: 1 });
    });
    const r = await client.updatePrReviewComment("o", "r", 1, { body: "y" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
  });
  it("deletePrReviewComment DELETEs /pulls/comments/{id}", async () => {
    let observed = { method: "", url: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({}, 204);
    });
    const r = await client.deletePrReviewComment("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("DELETE");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/comments\/1$/);
  });
});
```

- [ ] **Step 8: Run tests and commit**

```
npx vitest run tests/connectors/github && npm run typecheck
```
Expected: all passing.

```
git add src/connectors/github/lib/github_client.ts src/connectors/github/actions/comments.ts src/connectors/github/index.ts tests/connectors/github/unit/actions_comments.test.ts tests/connectors/github/unit/github_client_mutations.test.ts
git commit -m "feat(github): comment actions (issue + PR-review, CRUD)

Six new actions split across two GitHub APIs:
  - add/update/delete _issue_comment   (write, delete carries aspect)
  - add/update/delete _pr_review_comment (inline, requires commit_id + path + line)

Both deletes carry aspects: [\"delete\"] so the toolkit policy gate's
delete-aspect rule applies on top of the kind=write rule."
```
