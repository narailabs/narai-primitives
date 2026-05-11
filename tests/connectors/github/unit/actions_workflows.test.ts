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
                head_sha: "abc1234",
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
        head_sha: "abc1234",
      },
      sdk,
    )) as { total: number; runs: Array<{ id: number }> };
    expect(r).toMatchObject({ total: 1 });
    expect(queryObserved).toMatchObject({
      branch: "feat/x",
      status: "completed",
      event: "pull_request",
      head_sha: "abc1234",
    });
  });
});

describe("list_workflow_run_jobs", () => {
  it("returns jobs from a single page", async () => {
    const sdk = fakeSdk({
      listRunJobs: async () => ({
        ok: true,
        status: 200,
        data: {
          total_count: 2,
          jobs: [
            { id: 1, name: "build", status: "completed", conclusion: "success", run_id: 42 },
            { id: 2, name: "test", status: "completed", conclusion: "failure", run_id: 42 },
          ],
        },
      }),
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["list_workflow_run_jobs"]!,
      { owner: "o", repo: "r", run_id: 42 },
      sdk,
    )) as { total: number; jobs: Array<{ id: number; name: string }>; truncated: boolean };
    expect(r.total).toBe(2);
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]).toMatchObject({ id: 1, name: "build" });
    expect(r.truncated).toBe(false);
  });

  it("paginates and concatenates multiple pages", async () => {
    let callCount = 0;
    const sdk = fakeSdk({
      listRunJobs: async (_o, _r, _id, query) => {
        callCount++;
        const perPage = query?.per_page ?? 30;
        // page 1 returns a full page, page 2 returns a short page
        const jobs =
          (query?.page ?? 1) === 1
            ? Array.from({ length: perPage }, (_, i) => ({
                id: i + 1,
                name: `job-${i + 1}`,
                status: "completed",
                conclusion: "success",
                run_id: 1,
              }))
            : [{ id: 999, name: "last-job", status: "completed", conclusion: "success", run_id: 1 }];
        return { ok: true, status: 200, data: { total_count: jobs.length, jobs } };
      },
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["list_workflow_run_jobs"]!,
      { owner: "o", repo: "r", run_id: 1, max_results: 200 },
      sdk,
    )) as { total: number; truncated: boolean };
    expect(callCount).toBeGreaterThan(1);
    expect(r.truncated).toBe(false);
  });

  it("sets truncated=true when results exceed max_results", async () => {
    const sdk = fakeSdk({
      listRunJobs: async (_o, _r, _id, query) => {
        const perPage = query?.per_page ?? 30;
        const jobs = Array.from({ length: perPage }, (_, i) => ({
          id: i + 1,
          name: `job-${i + 1}`,
          status: "completed",
          conclusion: "success",
          run_id: 1,
        }));
        return { ok: true, status: 200, data: { total_count: jobs.length, jobs } };
      },
    });
    const a = buildWorkflowsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["list_workflow_run_jobs"]!,
      { owner: "o", repo: "r", run_id: 1, max_results: 5 },
      sdk,
    )) as { total: number; truncated: boolean };
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
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

  it("accepts string, number, and boolean inputs", async () => {
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
        inputs: { foo: "x", count: 3, enabled: true },
      },
      sdk,
    )) as { triggered: boolean };
    expect(r.triggered).toBe(true);
    expect(bodySent).toMatchObject({ ref: "main", inputs: { foo: "x", count: 3, enabled: true } });
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
