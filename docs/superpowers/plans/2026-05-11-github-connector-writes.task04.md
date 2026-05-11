# Task 4: PR actions module (`actions/pulls.ts`)

Add 5 client methods and 5 action specs covering `get_pull_request`, `create_pull_request` (with `require_draft_pr` enforcement), `update_pull_request` (state=closed rejected at schema), `close_pull_request` (write + delete aspect), and `merge_pull_request` (admin, with explicit 409-conflict handling).

**Files:**
- Modify: `src/connectors/github/lib/github_client.ts` (add 5 methods + types)
- Create: `src/connectors/github/actions/pulls.ts`
- Modify: `src/connectors/github/index.ts` (spread `buildPullsActions`)
- Create: `tests/connectors/github/unit/actions_pulls.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/connectors/github/unit/actions_pulls.test.ts`:

```ts
/**
 * Tests for actions/pulls.ts — schema validation, classification,
 * handler envelope shape, and the require_draft_pr enforcement path.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildPullsActions } from "../../../../src/connectors/github/actions/pulls.js";
import type { GithubClient } from "../../../../src/connectors/github/lib/github_client.js";

function fakeSdk(overrides: Partial<GithubClient> = {}): GithubClient {
  return overrides as unknown as GithubClient;
}

function runHandler<P>(
  spec: ActionSpec<P, GithubClient>,
  params: unknown,
  sdk: GithubClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

describe("buildPullsActions — classification", () => {
  const actions = buildPullsActions({ behavior: { requireDraftPr: false } });

  it("get_pull_request is read", () => {
    expect(actions["get_pull_request"]?.classify).toEqual({ kind: "read" });
  });
  it("create_pull_request is write", () => {
    expect(actions["create_pull_request"]?.classify).toEqual({ kind: "write" });
  });
  it("update_pull_request is write", () => {
    expect(actions["update_pull_request"]?.classify).toEqual({ kind: "write" });
  });
  it("close_pull_request is write + delete aspect", () => {
    expect(actions["close_pull_request"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
  it("merge_pull_request is admin", () => {
    expect(actions["merge_pull_request"]?.classify).toEqual({ kind: "admin" });
  });
});

describe("get_pull_request", () => {
  it("fetches and maps a PR by number", async () => {
    const sdk = fakeSdk({
      getPull: async () => ({
        ok: true,
        status: 200,
        data: {
          number: 42,
          title: "feat: x",
          state: "open",
          draft: false,
          user: { login: "alice" },
          base: { ref: "main", sha: "b0" },
          head: { ref: "feat/x", sha: "h0" },
          html_url: "https://github.com/o/r/pull/42",
          merged: false,
          mergeable: true,
          updated_at: "2026-05-01T00:00:00Z",
          body: "hello",
        },
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = await runHandler(
      actions["get_pull_request"]!,
      { owner: "o", repo: "r", pull_number: 42 },
      sdk,
    );
    expect(r).toMatchObject({
      number: 42,
      title: "feat: x",
      state: "open",
      draft: false,
      author: "alice",
      base_ref: "main",
      head_ref: "feat/x",
    });
  });
});

describe("create_pull_request — require_draft_pr enforcement", () => {
  it("forwards caller draft when require_draft_pr is false", async () => {
    let bodySent: Record<string, unknown> | null = null;
    const sdk = fakeSdk({
      createPull: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            number: 7,
            title: "t",
            state: "open",
            draft: false,
            html_url: "https://github.com/o/r/pull/7",
          },
        };
      },
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      actions["create_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        head: "feat/x",
        base: "main",
        draft: false,
      },
      sdk,
    )) as { draft_forced_by_config: boolean };
    expect(bodySent?.["draft"]).toBe(false);
    expect(r.draft_forced_by_config).toBe(false);
  });

  it("forces draft when require_draft_pr is true and caller asked for non-draft", async () => {
    let bodySent: Record<string, unknown> | null = null;
    const sdk = fakeSdk({
      createPull: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            number: 7,
            title: "t",
            state: "open",
            draft: true,
            html_url: "https://github.com/o/r/pull/7",
          },
        };
      },
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: true } });
    const r = (await runHandler(
      actions["create_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        head: "feat/x",
        base: "main",
        draft: false,
      },
      sdk,
    )) as { draft: boolean; draft_forced_by_config: boolean };
    expect(bodySent?.["draft"]).toBe(true);
    expect(r.draft).toBe(true);
    expect(r.draft_forced_by_config).toBe(true);
  });

  it("does not flag draft_forced_by_config when caller already asked for draft", async () => {
    const sdk = fakeSdk({
      createPull: async () => ({
        ok: true,
        status: 201,
        data: {
          number: 7,
          title: "t",
          state: "open",
          draft: true,
          html_url: "x",
        },
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: true } });
    const r = (await runHandler(
      actions["create_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        head: "feat/x",
        base: "main",
        draft: true,
      },
      sdk,
    )) as { draft_forced_by_config: boolean };
    expect(r.draft_forced_by_config).toBe(false);
  });
});

describe("update_pull_request — schema rejects state=closed", () => {
  const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
  it("accepts state=open", () => {
    expect(() =>
      actions["update_pull_request"]!.params.parse({
        owner: "o",
        repo: "r",
        pull_number: 1,
        state: "open",
      }),
    ).not.toThrow();
  });
  it("rejects state=closed (use close_pull_request)", () => {
    expect(() =>
      actions["update_pull_request"]!.params.parse({
        owner: "o",
        repo: "r",
        pull_number: 1,
        state: "closed",
      }),
    ).toThrow(/close_pull_request/);
  });
});

describe("close_pull_request", () => {
  it("calls closePull and returns a closed envelope", async () => {
    let called = false;
    const sdk = fakeSdk({
      closePull: async (o, r, n) => {
        called = true;
        return {
          ok: true,
          status: 200,
          data: { number: n, state: "closed", html_url: `https://x/${o}/${r}/${n}` },
        };
      },
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      actions["close_pull_request"]!,
      { owner: "o", repo: "r", pull_number: 9 },
      sdk,
    )) as { number: number; state: string; closed: boolean };
    expect(called).toBe(true);
    expect(r).toMatchObject({ number: 9, state: "closed", closed: true });
  });
});

describe("merge_pull_request", () => {
  it("returns a merged envelope on 200", async () => {
    const sdk = fakeSdk({
      mergePull: async () => ({
        ok: true,
        status: 200,
        data: { sha: "abc123", merged: true, message: "Pull Request successfully merged" },
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      actions["merge_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        pull_number: 3,
        merge_method: "squash",
      },
      sdk,
    )) as { merged: boolean; merge_sha: string };
    expect(r).toMatchObject({ merged: true, merge_sha: "abc123" });
  });

  it("translates 409 conflict to VALIDATION_ERROR", async () => {
    const sdk = fakeSdk({
      mergePull: async () => ({
        ok: false,
        code: "HTTP_ERROR",
        status: 409,
        message: "Head branch was modified",
        retriable: false,
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    await expect(
      runHandler(
        actions["merge_pull_request"]!,
        {
          owner: "o",
          repo: "r",
          pull_number: 3,
          merge_method: "merge",
        },
        sdk,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
```

- [ ] **Step 2: Run the test file — confirm all fail**

Run:
```
npx vitest run tests/connectors/github/unit/actions_pulls.test.ts
```
Expected: all fail (module `actions/pulls.js` not found).

- [ ] **Step 3: Add the 5 client methods to `lib/github_client.ts`**

Open `src/connectors/github/lib/github_client.ts`. Append, alongside the existing methods inside the `GithubClient` class (anywhere is fine — convention is grouped near related reads), the following:

```ts
  // ─── pull requests ──────────────────────────────────────────────────────
  public async getPull(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
    );
  }

  public async createPull(
    owner: string,
    repo: string,
    body: {
      title: string;
      head: string;
      base: string;
      body?: string;
      draft?: boolean;
      maintainer_can_modify?: boolean;
    },
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      { body },
    );
  }

  public async updatePull(
    owner: string,
    repo: string,
    pullNumber: number,
    body: {
      title?: string;
      body?: string;
      state?: "open";
      base?: string;
      maintainer_can_modify?: boolean;
    },
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
      { body },
    );
  }

  public async closePull(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
      { body: { state: "closed" } },
    );
  }

  public async mergePull(
    owner: string,
    repo: string,
    pullNumber: number,
    body: {
      commit_title?: string;
      commit_message?: string;
      sha?: string;
      merge_method: "merge" | "squash" | "rebase";
    },
  ): Promise<GithubResult<{ sha: string; merged: boolean; message: string }>> {
    return this._http.request(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      { body },
    );
  }
```

Add the `GithubPullDetail` interface near the existing `GithubPull` interface:

```ts
export interface GithubPullDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  user?: { login: string };
  base?: { ref: string; sha: string };
  head?: { ref: string; sha: string };
  html_url?: string;
  body?: string;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  updated_at?: string;
}
```

- [ ] **Step 4: Create `src/connectors/github/actions/pulls.ts`**

```ts
/**
 * Pull-request action specs: get / create / update / close / merge.
 *
 * Classification:
 *   - get_pull_request    : read
 *   - create_pull_request : write    (require_draft_pr forces draft=true)
 *   - update_pull_request : write    (schema rejects state=closed)
 *   - close_pull_request  : write + delete aspect
 *   - merge_pull_request  : admin    (operator opt-in via YAML)
 *
 * 409-on-merge: GitHub returns 409 when the head SHA changed between
 * the caller's read and our PUT. We surface that as a VALIDATION_ERROR
 * via a connector-local CONFLICT code (mapped in index.ts CODE_MAP).
 */
import { ConnectorError, throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const ownerRepoField = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "owner/repo: alphanumeric, dots, dashes, underscores only",
  );

const pullNumberField = z.coerce.number().int().positive();

const branchField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/+-]+$/, "Invalid branch name");

const getPullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
});

const createPullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  title: z.string().min(1),
  head: branchField,
  base: branchField,
  body: z.string().optional(),
  draft: z.boolean().default(false),
  maintainer_can_modify: z.boolean().optional(),
});

const updatePullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  base: branchField.optional(),
  maintainer_can_modify: z.boolean().optional(),
  state: z
    .enum(["open"], {
      errorMap: () => ({
        message:
          "update_pull_request only accepts state=open. Use close_pull_request to close.",
      }),
    })
    .optional(),
});

const closePullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
});

const mergeMethodField = z.enum(["merge", "squash", "rebase"]);

const mergePullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
  merge_method: mergeMethodField.default("merge"),
  commit_title: z.string().optional(),
  commit_message: z.string().optional(),
  sha: z.string().optional(),
});

function pullEnvelope(d: {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  user?: { login: string };
  base?: { ref: string; sha: string };
  head?: { ref: string; sha: string };
  html_url?: string;
  body?: string;
  merged?: boolean;
  mergeable?: boolean | null;
  updated_at?: string;
}) {
  return {
    number: d.number,
    title: d.title,
    state: d.state,
    draft: d.draft ?? false,
    author: d.user?.login ?? "",
    base_ref: d.base?.ref ?? "",
    head_ref: d.head?.ref ?? "",
    base_sha: d.base?.sha ?? "",
    head_sha: d.head?.sha ?? "",
    url: d.html_url ?? "",
    body_markdown: d.body ?? "",
    merged: d.merged ?? false,
    mergeable: d.mergeable ?? null,
    updated_at: d.updated_at ?? null,
  };
}

export function buildPullsActions(deps: GithubActionDeps): GithubActions {
  return {
    get_pull_request: {
      description: "Fetch a single pull request by number",
      params: getPullParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.getPull(p.owner, p.repo, p.pull_number);
        throwIfHttpError(r);
        return pullEnvelope(r.data);
      },
    },
    create_pull_request: {
      description:
        "Open a new pull request. Honors the require_draft_pr config knob.",
      params: createPullParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const requestedDraft = p.draft;
        const draftToUse = deps.behavior.requireDraftPr ? true : requestedDraft;
        const body: {
          title: string;
          head: string;
          base: string;
          body?: string;
          draft?: boolean;
          maintainer_can_modify?: boolean;
        } = {
          title: p.title,
          head: p.head,
          base: p.base,
          draft: draftToUse,
        };
        if (p.body !== undefined) body.body = p.body;
        if (p.maintainer_can_modify !== undefined)
          body.maintainer_can_modify = p.maintainer_can_modify;
        const r = await ctx.sdk.createPull(p.owner, p.repo, body);
        throwIfHttpError(r);
        return {
          ...pullEnvelope(r.data),
          draft_forced_by_config:
            deps.behavior.requireDraftPr && !requestedDraft,
        };
      },
    },
    update_pull_request: {
      description:
        "Update title, body, base, or set state=open (reopen). Closing is a separate action.",
      params: updatePullParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title?: string;
          body?: string;
          state?: "open";
          base?: string;
          maintainer_can_modify?: boolean;
        } = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.body !== undefined) body.body = p.body;
        if (p.state !== undefined) body.state = p.state;
        if (p.base !== undefined) body.base = p.base;
        if (p.maintainer_can_modify !== undefined)
          body.maintainer_can_modify = p.maintainer_can_modify;
        const r = await ctx.sdk.updatePull(p.owner, p.repo, p.pull_number, body);
        throwIfHttpError(r);
        return pullEnvelope(r.data);
      },
    },
    close_pull_request: {
      description: "Close a pull request (does not delete; GitHub has no REST hard-delete).",
      params: closePullParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.closePull(p.owner, p.repo, p.pull_number);
        throwIfHttpError(r);
        return {
          ...pullEnvelope(r.data),
          closed: true,
        };
      },
    },
    merge_pull_request: {
      description:
        "Merge a pull request. Admin-classified — operator must opt in via ~/.github-agent/config.yaml.",
      params: mergePullParams,
      classify: { kind: "admin" },
      handler: async (p, ctx) => {
        const body: {
          merge_method: "merge" | "squash" | "rebase";
          commit_title?: string;
          commit_message?: string;
          sha?: string;
        } = { merge_method: p.merge_method };
        if (p.commit_title !== undefined) body.commit_title = p.commit_title;
        if (p.commit_message !== undefined)
          body.commit_message = p.commit_message;
        if (p.sha !== undefined) body.sha = p.sha;
        const r = await ctx.sdk.mergePull(
          p.owner,
          p.repo,
          p.pull_number,
          body,
        );
        if (!r.ok && r.status === 409) {
          throw new ConnectorError(
            "CONFLICT",
            `merge_pull_request: head SHA changed mid-merge (${r.message})`,
            false,
          );
        }
        throwIfHttpError(r);
        return {
          owner: p.owner,
          repo: p.repo,
          pull_number: p.pull_number,
          merged: r.data.merged,
          merge_sha: r.data.sha,
          message: r.data.message,
        };
      },
    },
  };
}
```

- [ ] **Step 5: Wire `buildPullsActions` into `index.ts` + extend `CODE_MAP`**

In `src/connectors/github/index.ts`, add the import:

```ts
import { buildPullsActions } from "./actions/pulls.js";
```

Spread inside the `actions` map:

```ts
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
    },
```

Add `CONFLICT` to `CODE_MAP`:

```ts
const CODE_MAP: Record<string, ErrorCode> = {
  // ... existing entries
  CONFLICT: "VALIDATION_ERROR",
};
```

- [ ] **Step 6: Run the test file — confirm all pass**

Run:
```
npx vitest run tests/connectors/github/unit/actions_pulls.test.ts
```
Expected: all passing.

- [ ] **Step 7: Add 5 client-method assertions to `github_client_mutations.test.ts`**

Append to `tests/connectors/github/unit/github_client_mutations.test.ts`:

```ts
describe("GithubClient — pull-request methods", () => {
  it("getPull issues GET /repos/o/r/pulls/{n}", async () => {
    let observed: { url: string; method: string } = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t", state: "open" });
    });
    const r = await client.getPull("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("GET");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/1$/);
  });

  it("createPull issues POST with body", async () => {
    let observedBody = "";
    const client = makeClient(async (_url, init) => {
      observedBody = String(init?.body ?? "");
      return jsonResponse({ number: 1, title: "t", state: "open", draft: true });
    });
    const r = await client.createPull("o", "r", {
      title: "t",
      head: "f",
      base: "main",
      draft: true,
    });
    expect(r.ok).toBe(true);
    expect(observedBody).toContain('"title":"t"');
    expect(observedBody).toContain('"draft":true');
  });

  it("updatePull issues PATCH", async () => {
    let observed: { url: string; method: string } = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t2", state: "open" });
    });
    const r = await client.updatePull("o", "r", 1, { title: "t2" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/1$/);
  });

  it("closePull issues PATCH with state=closed", async () => {
    let observedBody = "";
    const client = makeClient(async (_url, init) => {
      observedBody = String(init?.body ?? "");
      return jsonResponse({ number: 1, title: "t", state: "closed" });
    });
    const r = await client.closePull("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observedBody).toContain('"state":"closed"');
  });

  it("mergePull issues PUT to /merge", async () => {
    let observed: { url: string; method: string; body: string } = {
      url: "",
      method: "",
      body: "",
    };
    const client = makeClient(async (url, init) => {
      observed = {
        url,
        method: String(init?.method ?? ""),
        body: String(init?.body ?? ""),
      };
      return jsonResponse({ sha: "abc", merged: true, message: "ok" });
    });
    const r = await client.mergePull("o", "r", 1, { merge_method: "squash" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PUT");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/1\/merge$/);
    expect(observed.body).toContain('"merge_method":"squash"');
  });

  it("mergePull surfaces 409 as a structured error with status set", async () => {
    const client = makeClient(async () =>
      jsonResponse({ message: "Head branch was modified" }, 409),
    );
    const r = await client.mergePull("o", "r", 1, { merge_method: "merge" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
    }
  });
});
```

- [ ] **Step 8: Run all github tests**

Run:
```
npx vitest run tests/connectors/github
```
Expected: all passing.

- [ ] **Step 9: Typecheck and full suite**

```
npm run typecheck && npm test
```
Expected: passes.

- [ ] **Step 10: Commit**

```
git add src/connectors/github/lib/github_client.ts src/connectors/github/actions/pulls.ts src/connectors/github/index.ts tests/connectors/github/unit/actions_pulls.test.ts tests/connectors/github/unit/github_client_mutations.test.ts
git commit -m "feat(github): PR actions (get/create/update/close/merge)

Adds 5 pull-request actions:
  - get_pull_request    (read)
  - create_pull_request (write) — honors require_draft_pr config
  - update_pull_request (write) — schema rejects state=closed
  - close_pull_request  (write + delete aspect)
  - merge_pull_request  (admin) — operator opt-in, 409 mapped to
                                  VALIDATION_ERROR via CONFLICT code

Also adds CONFLICT to CODE_MAP. Module pattern follows
actions/reads.ts established in the previous task."
```
