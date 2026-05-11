# Task 8: Workflow actions module (`actions/workflows.ts`)

Add 8 client methods and 8 action specs covering Actions workflow runs: list/get/list-jobs/get-logs (read) + rerun/rerun-failed/cancel/trigger-dispatch (write). The logs endpoint uses `redirect: "manual"` to capture the 302 Location header without downloading the ZIP body.

**Files:**
- Modify: `src/connectors/github/lib/github_client.ts` (add 8 methods + types)
- Create: `src/connectors/github/actions/workflows.ts`
- Modify: `src/connectors/github/index.ts` (spread `buildWorkflowsActions`)
- Create: `tests/connectors/github/unit/actions_workflows.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/connectors/github/unit/actions_workflows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildWorkflowsActions } from "../../../../src/connectors/github/actions/workflows.js";
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

describe("buildWorkflowsActions — classification", () => {
  const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
  it("read actions", () => {
    expect(a["list_workflow_runs"]?.classify).toEqual({ kind: "read" });
    expect(a["get_workflow_run"]?.classify).toEqual({ kind: "read" });
    expect(a["list_workflow_run_jobs"]?.classify).toEqual({ kind: "read" });
    expect(a["get_workflow_run_logs"]?.classify).toEqual({ kind: "read" });
  });
  it("write actions", () => {
    expect(a["rerun_workflow_run"]?.classify).toEqual({ kind: "write" });
    expect(a["rerun_failed_jobs"]?.classify).toEqual({ kind: "write" });
    expect(a["cancel_workflow_run"]?.classify).toEqual({ kind: "write" });
    expect(a["trigger_workflow_dispatch"]?.classify).toEqual({ kind: "write" });
  });
});

describe("list_workflow_runs", () => {
  it("filters by branch/status/event/head_sha", async () => {
    let queryObserved: Record<string, unknown> = {};
    const sdk = fakeSdk({
      listWorkflowRuns: async (_o, _r, query) => {
        queryObserved = query as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          data: {
            total_count: 1,
            workflow_runs: [
              {
                id: 555,
                name: "ci",
                status: "completed",
                conclusion: "success",
                event: "pull_request",
                head_branch: "feat/x",
                head_sha: "abc",
                run_number: 12,
                html_url: "u",
                created_at: "x",
                updated_at: "y",
              },
            ],
          },
        };
      },
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["list_workflow_runs"]!,
      {
        owner: "o",
        repo: "r",
        branch: "feat/x",
        status: "completed",
        event: "pull_request",
        head_sha: "abc",
      },
      sdk,
    )) as { total: number; runs: Array<{ id: number }> };
    expect(r).toMatchObject({ total: 1 });
    expect(queryObserved).toMatchObject({
      branch: "feat/x",
      status: "completed",
      event: "pull_request",
      head_sha: "abc",
    });
  });
});

describe("get_workflow_run_logs returns redirect URL without body", () => {
  it("returns { url } from the captured Location header", async () => {
    const sdk = fakeSdk({
      getRunLogsRedirect: async () => ({
        ok: true,
        status: 200,
        data: {
          url: "https://pipelines.actions.githubusercontent.com/x/logs.zip",
          content_length: 1234,
        },
      }),
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["get_workflow_run_logs"]!,
      { owner: "o", repo: "r", run_id: 555 },
      sdk,
    )) as { url: string; content_length: number };
    expect(r.url).toMatch(/logs\.zip$/);
    expect(r.content_length).toBe(1234);
  });
});

describe("rerun_workflow_run", () => {
  it("POSTs and returns { triggered: true }", async () => {
    const sdk = fakeSdk({
      rerunRun: async () => ({ ok: true, status: 201, data: undefined as unknown }),
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["rerun_workflow_run"]!,
      { owner: "o", repo: "r", run_id: 1 },
      sdk,
    )) as { triggered: boolean };
    expect(r.triggered).toBe(true);
  });
});

describe("rerun_failed_jobs", () => {
  it("hits the rerun-failed-jobs endpoint", async () => {
    const sdk = fakeSdk({
      rerunFailedJobs: async () => ({ ok: true, status: 201, data: undefined as unknown }),
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["rerun_failed_jobs"]!,
      { owner: "o", repo: "r", run_id: 1 },
      sdk,
    )) as { triggered: boolean };
    expect(r.triggered).toBe(true);
  });
});

describe("cancel_workflow_run", () => {
  it("POSTs and returns { cancelled: true }", async () => {
    const sdk = fakeSdk({
      cancelRun: async () => ({ ok: true, status: 202, data: undefined as unknown }),
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["cancel_workflow_run"]!,
      { owner: "o", repo: "r", run_id: 1 },
      sdk,
    )) as { cancelled: boolean };
    expect(r.cancelled).toBe(true);
  });
});

describe("trigger_workflow_dispatch", () => {
  it("validates workflow_id_or_filename and passes inputs through", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      triggerWorkflowDispatch: async (_o, _r, _wf, body) => {
        bodySent = body;
        return { ok: true, status: 204, data: undefined as unknown };
      },
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["trigger_workflow_dispatch"]!,
      {
        owner: "o",
        repo: "r",
        workflow_id_or_filename: "ci.yml",
        ref: "main",
        inputs: { foo: "bar" },
      },
      sdk,
    )) as { triggered: boolean };
    expect(r.triggered).toBe(true);
    expect(bodySent).toMatchObject({ ref: "main", inputs: { foo: "bar" } });
  });

  it("schema rejects an invalid workflow id", () => {
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    expect(() =>
      a["trigger_workflow_dispatch"]!.params.parse({
        owner: "o",
        repo: "r",
        workflow_id_or_filename: "../escape.yml",
        ref: "main",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/connectors/github/unit/actions_workflows.test.ts
```

- [ ] **Step 3: Add the 8 client methods + types**

Append types in `lib/github_client.ts`:

```ts
export interface GithubWorkflowRun {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  run_number?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GithubWorkflowRunsList {
  total_count: number;
  workflow_runs: GithubWorkflowRun[];
}

export interface GithubWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string | null;
  html_url?: string;
  run_id: number;
}

export interface GithubWorkflowJobsList {
  total_count: number;
  jobs: GithubWorkflowJob[];
}
```

Append methods to `GithubClient`:

```ts
  // ─── workflows / Actions ────────────────────────────────────────────────
  public async listWorkflowRuns(
    owner: string,
    repo: string,
    query: {
      branch?: string;
      event?: string;
      status?: string;
      head_sha?: string;
      per_page?: number;
      page?: number;
    },
  ): Promise<GithubResult<GithubWorkflowRunsList>> {
    return this._http.request<GithubWorkflowRunsList>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs`,
      { query },
    );
  }
  public async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubResult<GithubWorkflowRun>> {
    return this._http.request<GithubWorkflowRun>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}`,
    );
  }
  public async listRunJobs(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubResult<GithubWorkflowJobsList>> {
    return this._http.request<GithubWorkflowJobsList>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
    );
  }
  /**
   * Returns the 302 redirect URL for run logs without downloading the ZIP.
   * Uses fetchImpl directly with redirect: "manual" so we can capture the
   * Location header. Falls back to the normal _http.request if fetchImpl
   * unavailable (testing convenience).
   */
  public async getRunLogsRedirect(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubResult<{ url: string; content_length: number | null }>> {
    const path = `/repos/${owner}/${repo}/actions/runs/${runId}/logs`;
    const url = new URL(path, this._http.baseUrl).toString();
    const fetchFn = (this as unknown as {
      _http: { _fetch: typeof globalThis.fetch };
    })._http._fetch;
    let resp: Response;
    try {
      resp = await fetchFn(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: this._authHeaderForLogs,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      });
    } catch (e) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: e instanceof Error ? e.message : String(e),
        retriable: true,
      };
    }
    if (resp.status !== 302 && resp.status !== 200) {
      return {
        ok: false,
        code: "HTTP_ERROR",
        status: resp.status,
        message: `Unexpected status ${resp.status} from logs endpoint`,
        retriable: false,
      };
    }
    const location = resp.headers.get("location") ?? "";
    const lenHdr = resp.headers.get("content-length");
    return {
      ok: true,
      status: resp.status,
      data: {
        url: location,
        content_length: lenHdr ? Number(lenHdr) : null,
      },
    };
  }
  public async rerunRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "POST",
      `/repos/${owner}/${repo}/actions/runs/${runId}/rerun`,
    );
  }
  public async rerunFailedJobs(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "POST",
      `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`,
    );
  }
  public async cancelRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "POST",
      `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`,
    );
  }
  public async triggerWorkflowDispatch(
    owner: string,
    repo: string,
    workflowIdOrFilename: string,
    body: { ref: string; inputs?: Record<string, string> },
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "POST",
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowIdOrFilename)}/dispatches`,
      { body },
    );
  }
```

Inside the constructor, capture the auth header for the logs path's manual-redirect call:

```ts
    this._authHeaderForLogs = `Bearer ${opts.token}`;
```

And declare the private field near `_defaultOwner`:

```ts
  private readonly _authHeaderForLogs: string;
```

- [ ] **Step 4: Create `actions/workflows.ts`**

```ts
/**
 * Actions/Workflows action specs:
 *  - reads: list_workflow_runs, get_workflow_run, list_workflow_run_jobs,
 *           get_workflow_run_logs (returns redirect URL, not the ZIP body)
 *  - writes: rerun_workflow_run, rerun_failed_jobs, cancel_workflow_run,
 *            trigger_workflow_dispatch
 *
 * Out of scope (deferred to a future task): approve_workflow_run
 * (admin — fork PR approval) and delete_workflow_run (admin).
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const ownerRepoField = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/, "owner/repo: alphanumeric, dots, dashes, underscores only");
const runIdField = z.coerce.number().int().positive();
const refField = z.string().min(1).regex(/^[A-Za-z0-9._/+-]+$/, "Invalid ref");
const branchField = z.string().min(1).regex(/^[A-Za-z0-9._/+-]+$/);
const shaField = z.string().regex(/^[a-f0-9]{7,40}$/);
const workflowIdField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "workflow_id_or_filename: alphanumerics, dot, dash, underscore only")
  .refine((s) => !s.includes(".."), { message: "Path traversal not allowed" });

const listRunsParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  branch: branchField.optional(),
  event: z.string().optional(),
  status: z
    .enum([
      "queued",
      "in_progress",
      "completed",
      "waiting",
      "requested",
      "pending",
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "success",
      "timed_out",
    ])
    .optional(),
  head_sha: shaField.optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const runIdParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  run_id: runIdField,
});

const dispatchParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  workflow_id_or_filename: workflowIdField,
  ref: refField,
  inputs: z.record(z.string()).optional(),
});

function runEnvelope(r: {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  run_number?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}) {
  return {
    id: r.id,
    name: r.name ?? "",
    status: r.status ?? "",
    conclusion: r.conclusion ?? null,
    event: r.event ?? "",
    head_branch: r.head_branch ?? "",
    head_sha: r.head_sha ?? "",
    run_number: r.run_number ?? null,
    url: r.html_url ?? "",
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

export function buildWorkflowsActions(_deps: GithubActionDeps): GithubActions {
  return {
    list_workflow_runs: {
      description:
        "List workflow runs filtered by branch/event/status/head_sha — pass head_sha to find runs for a specific PR's head commit.",
      params: listRunsParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const query: {
          branch?: string;
          event?: string;
          status?: string;
          head_sha?: string;
          per_page?: number;
          page?: number;
        } = {};
        if (p.branch !== undefined) query.branch = p.branch;
        if (p.event !== undefined) query.event = p.event;
        if (p.status !== undefined) query.status = p.status;
        if (p.head_sha !== undefined) query.head_sha = p.head_sha;
        if (p.per_page !== undefined) query.per_page = p.per_page;
        if (p.page !== undefined) query.page = p.page;
        const r = await ctx.sdk.listWorkflowRuns(p.owner, p.repo, query);
        throwIfHttpError(r);
        return {
          total: r.data.total_count,
          runs: (r.data.workflow_runs ?? []).map(runEnvelope),
        };
      },
    },
    get_workflow_run: {
      description: "Fetch a single workflow run by id",
      params: runIdParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.getWorkflowRun(p.owner, p.repo, p.run_id);
        throwIfHttpError(r);
        return runEnvelope(r.data);
      },
    },
    list_workflow_run_jobs: {
      description: "List the jobs inside a workflow run",
      params: runIdParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.listRunJobs(p.owner, p.repo, p.run_id);
        throwIfHttpError(r);
        return {
          total: r.data.total_count,
          jobs: (r.data.jobs ?? []).map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion ?? null,
            started_at: j.started_at ?? null,
            completed_at: j.completed_at ?? null,
            url: j.html_url ?? "",
            run_id: j.run_id,
          })),
        };
      },
    },
    get_workflow_run_logs: {
      description:
        "Get the temporary download URL for a run's logs ZIP. Does not download the body.",
      params: runIdParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.getRunLogsRedirect(p.owner, p.repo, p.run_id);
        throwIfHttpError(r);
        return {
          run_id: p.run_id,
          url: r.data.url,
          content_length: r.data.content_length,
        };
      },
    },
    rerun_workflow_run: {
      description: "Re-run all jobs in a workflow run",
      params: runIdParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.rerunRun(p.owner, p.repo, p.run_id);
        throwIfHttpError(r);
        return { run_id: p.run_id, triggered: true };
      },
    },
    rerun_failed_jobs: {
      description: "Re-run only the failed jobs in a workflow run",
      params: runIdParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.rerunFailedJobs(p.owner, p.repo, p.run_id);
        throwIfHttpError(r);
        return { run_id: p.run_id, triggered: true };
      },
    },
    cancel_workflow_run: {
      description: "Cancel an in-flight workflow run",
      params: runIdParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.cancelRun(p.owner, p.repo, p.run_id);
        throwIfHttpError(r);
        return { run_id: p.run_id, cancelled: true };
      },
    },
    trigger_workflow_dispatch: {
      description:
        "Manually trigger a workflow_dispatch event on a workflow (by id or filename), at a ref, with optional inputs.",
      params: dispatchParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: { ref: string; inputs?: Record<string, string> } = {
          ref: p.ref,
        };
        if (p.inputs !== undefined) body.inputs = p.inputs;
        const r = await ctx.sdk.triggerWorkflowDispatch(
          p.owner,
          p.repo,
          p.workflow_id_or_filename,
          body,
        );
        throwIfHttpError(r);
        return {
          workflow: p.workflow_id_or_filename,
          ref: p.ref,
          triggered: true,
        };
      },
    },
  };
}
```

- [ ] **Step 5: Wire into `index.ts`**

```ts
import { buildWorkflowsActions } from "./actions/workflows.js";
```

```ts
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
      ...buildIssuesActions({ behavior }),
      ...buildCommentsActions({ behavior }),
      ...buildReleasesActions({ behavior }),
      ...buildWorkflowsActions({ behavior }),
    },
```

- [ ] **Step 6: Run tests**

```
npx vitest run tests/connectors/github/unit/actions_workflows.test.ts
```
Expected: all passing.

- [ ] **Step 7: Append client-method tests to `github_client_mutations.test.ts`**

```ts
describe("GithubClient — workflow methods", () => {
  it("listWorkflowRuns GETs /actions/runs with query", async () => {
    let observed = { url: "" };
    const client = makeClient(async (url) => {
      observed = { url };
      return jsonResponse({ total_count: 0, workflow_runs: [] });
    });
    const r = await client.listWorkflowRuns("o", "r", { branch: "main" });
    expect(r.ok).toBe(true);
    expect(observed.url).toMatch(/\/actions\/runs/);
    expect(observed.url).toContain("branch=main");
  });
  it("rerunRun POSTs /actions/runs/{id}/rerun", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({}, 201);
    });
    const r = await client.rerunRun("o", "r", 5);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("POST");
    expect(observed.url).toMatch(/\/actions\/runs\/5\/rerun$/);
  });
  it("triggerWorkflowDispatch POSTs /actions/workflows/{wf}/dispatches", async () => {
    let observed = { url: "", body: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, body: String(init?.body ?? "") };
      return jsonResponse({}, 204);
    });
    const r = await client.triggerWorkflowDispatch("o", "r", "ci.yml", {
      ref: "main",
      inputs: { foo: "bar" },
    });
    expect(r.ok).toBe(true);
    expect(observed.url).toMatch(/\/actions\/workflows\/ci\.yml\/dispatches$/);
    expect(observed.body).toContain('"ref":"main"');
  });
  it("getRunLogsRedirect captures Location from 302", async () => {
    const client = makeClient(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location:
            "https://pipelines.actions.githubusercontent.com/x/logs.zip",
          "content-length": "1024",
        },
      }),
    );
    const r = await client.getRunLogsRedirect("o", "r", 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.url).toMatch(/logs\.zip$/);
      expect(r.data.content_length).toBe(1024);
    }
  });
});
```

- [ ] **Step 8: Run all github tests and commit**

```
npx vitest run tests/connectors/github && npm run typecheck
```
Expected: all passing.

```
git add src/connectors/github/lib/github_client.ts src/connectors/github/actions/workflows.ts src/connectors/github/index.ts tests/connectors/github/unit/actions_workflows.test.ts tests/connectors/github/unit/github_client_mutations.test.ts
git commit -m "feat(github): Actions/workflow actions (8 actions)

Read: list_workflow_runs (with head_sha filter for PR runs),
get_workflow_run, list_workflow_run_jobs, get_workflow_run_logs.
Write: rerun_workflow_run, rerun_failed_jobs, cancel_workflow_run,
trigger_workflow_dispatch.

get_workflow_run_logs uses redirect: \"manual\" to capture the 302
Location header rather than downloading the ZIP body."
```
