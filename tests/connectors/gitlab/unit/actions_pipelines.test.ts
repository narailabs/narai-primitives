/**
 * Tests for gitlab/actions/pipelines.ts — classification, schemas, and handlers
 * for retry_pipeline, retry_failed_jobs, cancel_pipeline, trigger_pipeline,
 * and play_job.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildPipelinesActions } from "../../../../src/connectors/gitlab/actions/pipelines.js";
import type { GitlabClient } from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

function fakeSdk(overrides: Partial<GitlabClient> = {}): GitlabClient {
  return overrides as unknown as GitlabClient;
}

function runHandler<P>(
  spec: ActionSpec<P, GitlabClient>,
  params: unknown,
  sdk: GitlabClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

const baseDeps = {
  behavior: { requireDraftMr: false, host: "https://gitlab.com" },
};

const pipelineResponse = {
  id: 101,
  status: "running",
  ref: "main",
  sha: "abc123",
  web_url: "https://gitlab.com/g/p/-/pipelines/101",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const jobResponse = {
  id: 55,
  name: "deploy",
  stage: "deploy",
  status: "running",
  web_url: "https://gitlab.com/g/p/-/jobs/55",
  created_at: "2024-01-01T00:00:00Z",
  started_at: null,
  finished_at: null,
  duration: null,
};

// ── Classification ────────────────────────────────────────────────────────────

describe("buildPipelinesActions — classification", () => {
  const actions = buildPipelinesActions(baseDeps);

  it("retry_pipeline is write", () => {
    expect(actions["retry_pipeline"]?.classify).toEqual({ kind: "write" });
  });

  it("retry_failed_jobs is write", () => {
    expect(actions["retry_failed_jobs"]?.classify).toEqual({ kind: "write" });
  });

  it("cancel_pipeline is write", () => {
    expect(actions["cancel_pipeline"]?.classify).toEqual({ kind: "write" });
  });

  it("trigger_pipeline is write", () => {
    expect(actions["trigger_pipeline"]?.classify).toEqual({ kind: "write" });
  });

  it("play_job is write", () => {
    expect(actions["play_job"]?.classify).toEqual({ kind: "write" });
  });
});

// ── retry_pipeline ────────────────────────────────────────────────────────────

describe("retry_pipeline", () => {
  it("calls retryPipeline and returns updated pipeline data", async () => {
    let calledWith: { ns: string; proj: string; pipelineId: number } | null = null;
    const sdk = fakeSdk({
      retryPipeline: async (ns, proj, pipelineId) => {
        calledWith = { ns, proj, pipelineId };
        return {
          ok: true as const,
          status: 200,
          data: { ...pipelineResponse, status: "running" },
        };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    const result = (await runHandler(
      actions["retry_pipeline"]!,
      { namespace: "mygroup", project: "myproject", pipeline_id: 101 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["id"]).toBe(101);
    expect(result["status"]).toBe("running");
    expect(calledWith).toEqual({ ns: "mygroup", proj: "myproject", pipelineId: 101 });
  });

  it("schema rejects non-positive pipeline_id", () => {
    const actions = buildPipelinesActions(baseDeps);
    expect(() =>
      actions["retry_pipeline"]!.params.parse({
        namespace: "g",
        project: "p",
        pipeline_id: 0,
      }),
    ).toThrow();
  });

  it("propagates HTTP errors (e.g. 404)", async () => {
    const sdk = fakeSdk({
      retryPipeline: async () => ({
        ok: false as const,
        status: 404,
        data: { message: "404 Not Found" },
      }),
    });
    const actions = buildPipelinesActions(baseDeps);
    await expect(
      runHandler(
        actions["retry_pipeline"]!,
        { namespace: "g", project: "p", pipeline_id: 999 },
        sdk,
      ),
    ).rejects.toThrow();
  });
});

// ── retry_failed_jobs ─────────────────────────────────────────────────────────

describe("retry_failed_jobs", () => {
  it("calls the same retryPipeline client method as retry_pipeline", async () => {
    let callCount = 0;
    const sdk = fakeSdk({
      retryPipeline: async () => {
        callCount++;
        return { ok: true as const, status: 200, data: { ...pipelineResponse } };
      },
    });
    const actions = buildPipelinesActions(baseDeps);

    await runHandler(
      actions["retry_failed_jobs"]!,
      { namespace: "g", project: "p", pipeline_id: 101 },
      sdk,
    );

    expect(callCount).toBe(1);
  });

  it("returns the same pipeline data shape as retry_pipeline", async () => {
    const sdk = fakeSdk({
      retryPipeline: async () => ({
        ok: true as const,
        status: 200,
        data: { ...pipelineResponse, status: "running" },
      }),
    });
    const actions = buildPipelinesActions(baseDeps);
    const result = (await runHandler(
      actions["retry_failed_jobs"]!,
      { namespace: "g", project: "p", pipeline_id: 101 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["id"]).toBe(101);
    expect(result["status"]).toBe("running");
  });

  it("schema rejects missing pipeline_id", () => {
    const actions = buildPipelinesActions(baseDeps);
    expect(() =>
      actions["retry_failed_jobs"]!.params.parse({ namespace: "g", project: "p" }),
    ).toThrow();
  });
});

// ── cancel_pipeline ───────────────────────────────────────────────────────────

describe("cancel_pipeline", () => {
  it("calls cancelPipeline and returns canceled pipeline data", async () => {
    let calledWith: { ns: string; proj: string; pipelineId: number } | null = null;
    const sdk = fakeSdk({
      cancelPipeline: async (ns, proj, pipelineId) => {
        calledWith = { ns, proj, pipelineId };
        return {
          ok: true as const,
          status: 200,
          data: { ...pipelineResponse, status: "canceled" },
        };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    const result = (await runHandler(
      actions["cancel_pipeline"]!,
      { namespace: "mygroup", project: "myproject", pipeline_id: 101 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["id"]).toBe(101);
    expect(result["status"]).toBe("canceled");
    expect(calledWith).toEqual({ ns: "mygroup", proj: "myproject", pipelineId: 101 });
  });

  it("propagates HTTP errors (e.g. 404)", async () => {
    const sdk = fakeSdk({
      cancelPipeline: async () => ({
        ok: false as const,
        status: 404,
        data: { message: "404 Not Found" },
      }),
    });
    const actions = buildPipelinesActions(baseDeps);
    await expect(
      runHandler(
        actions["cancel_pipeline"]!,
        { namespace: "g", project: "p", pipeline_id: 999 },
        sdk,
      ),
    ).rejects.toThrow();
  });
});

// ── trigger_pipeline ──────────────────────────────────────────────────────────

describe("trigger_pipeline", () => {
  it("calls triggerPipeline with token, ref and returns new pipeline data", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      triggerPipeline: async (ns, proj, body) => {
        capturedBody = body as Record<string, unknown>;
        return {
          ok: true as const,
          status: 201,
          data: { ...pipelineResponse, id: 202 },
        };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    const result = (await runHandler(
      actions["trigger_pipeline"]!,
      {
        namespace: "mygroup",
        project: "myproject",
        token: "glptt_trigger_token",
        ref: "main",
      },
      sdk,
    )) as Record<string, unknown>;

    expect(result["id"]).toBe(202);
    expect(capturedBody["token"]).toBe("glptt_trigger_token");
    expect(capturedBody["ref"]).toBe("main");
  });

  it("passes variables when provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      triggerPipeline: async (_ns, _proj, body) => {
        capturedBody = body as Record<string, unknown>;
        return { ok: true as const, status: 201, data: { ...pipelineResponse } };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    await runHandler(
      actions["trigger_pipeline"]!,
      {
        namespace: "g",
        project: "p",
        token: "tok",
        ref: "feat/branch",
        variables: { FOO: "bar", BAZ: "qux" },
      },
      sdk,
    );

    expect(capturedBody["variables"]).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("omits variables from body when not provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      triggerPipeline: async (_ns, _proj, body) => {
        capturedBody = body as Record<string, unknown>;
        return { ok: true as const, status: 201, data: { ...pipelineResponse } };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    await runHandler(
      actions["trigger_pipeline"]!,
      { namespace: "g", project: "p", token: "tok", ref: "main" },
      sdk,
    );

    expect(capturedBody["variables"]).toBeUndefined();
  });

  it("schema rejects missing token", () => {
    const actions = buildPipelinesActions(baseDeps);
    expect(() =>
      actions["trigger_pipeline"]!.params.parse({
        namespace: "g",
        project: "p",
        ref: "main",
      }),
    ).toThrow();
  });

  it("schema rejects missing ref", () => {
    const actions = buildPipelinesActions(baseDeps);
    expect(() =>
      actions["trigger_pipeline"]!.params.parse({
        namespace: "g",
        project: "p",
        token: "tok",
      }),
    ).toThrow();
  });

  it("propagates HTTP errors (e.g. 403 invalid token)", async () => {
    const sdk = fakeSdk({
      triggerPipeline: async () => ({
        ok: false as const,
        status: 403,
        data: { message: "403 Forbidden" },
      }),
    });
    const actions = buildPipelinesActions(baseDeps);
    await expect(
      runHandler(
        actions["trigger_pipeline"]!,
        { namespace: "g", project: "p", token: "bad", ref: "main" },
        sdk,
      ),
    ).rejects.toThrow();
  });
});

// ── play_job ──────────────────────────────────────────────────────────────────

describe("play_job", () => {
  it("calls playJob and returns job data", async () => {
    let calledWith: { ns: string; proj: string; jobId: number } | null = null;
    const sdk = fakeSdk({
      playJob: async (ns, proj, jobId) => {
        calledWith = { ns, proj, jobId };
        return {
          ok: true as const,
          status: 200,
          data: { ...jobResponse, status: "running" },
        };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    const result = (await runHandler(
      actions["play_job"]!,
      { namespace: "mygroup", project: "myproject", job_id: 55 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["id"]).toBe(55);
    expect(result["status"]).toBe("running");
    expect(calledWith).toEqual({ ns: "mygroup", proj: "myproject", jobId: 55 });
  });

  it("passes variables when provided", async () => {
    let capturedVars: Record<string, unknown> | undefined;
    const sdk = fakeSdk({
      playJob: async (_ns, _proj, _jobId, vars) => {
        capturedVars = vars;
        return { ok: true as const, status: 200, data: { ...jobResponse } };
      },
    });
    const actions = buildPipelinesActions(baseDeps);
    await runHandler(
      actions["play_job"]!,
      {
        namespace: "g",
        project: "p",
        job_id: 55,
        variables: { DEPLOY_ENV: "staging" },
      },
      sdk,
    );

    expect(capturedVars).toEqual({ DEPLOY_ENV: "staging" });
  });

  it("schema rejects non-positive job_id", () => {
    const actions = buildPipelinesActions(baseDeps);
    expect(() =>
      actions["play_job"]!.params.parse({
        namespace: "g",
        project: "p",
        job_id: -1,
      }),
    ).toThrow();
  });

  it("propagates HTTP errors (e.g. 404 job not found)", async () => {
    const sdk = fakeSdk({
      playJob: async () => ({
        ok: false as const,
        status: 404,
        data: { message: "404 Not Found" },
      }),
    });
    const actions = buildPipelinesActions(baseDeps);
    await expect(
      runHandler(
        actions["play_job"]!,
        { namespace: "g", project: "p", job_id: 999 },
        sdk,
      ),
    ).rejects.toThrow();
  });
});
