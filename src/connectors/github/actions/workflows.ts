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
import { ownerRepoField, branchField } from "./_fields.js";
import { paginate } from "./_pagination.js";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const runIdField = z.coerce.number().int().positive();
const refField = z.string().min(1).regex(/^[A-Za-z0-9._/+-]+$/, "Invalid ref");
const shaField = z.string().regex(/^[a-f0-9]{7,40}$/);
const workflowIdField = z
  .union([
    z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "workflow_id_or_filename: alphanumerics, dot, dash, underscore only",
      )
      .refine((s) => !s.includes(".."), { message: "Path traversal not allowed" }),
    z.number().int().positive(),
  ])
  .transform((v) => String(v));

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

const MAX_RESULTS_DEFAULT = 30;
const MAX_RESULTS_CAP = 1000;

const listRunJobsParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  run_id: runIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const dispatchParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  workflow_id_or_filename: workflowIdField,
  ref: refField,
  inputs: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
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
      description: "List the jobs inside a workflow run, paginated up to max_results",
      params: listRunJobsParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginate<import("../lib/github_client.js").GithubWorkflowJob>(
          limit,
          async (pageNum, perPage) => {
            const r = await ctx.sdk.listRunJobs(p.owner, p.repo, p.run_id, {
              per_page: perPage,
              page: pageNum,
            });
            if (!r.ok) return r;
            return { ok: true as const, status: r.status, data: r.data.jobs ?? [] };
          },
        );
        return {
          total: page.items.length,
          jobs: page.items.map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion ?? null,
            started_at: j.started_at ?? null,
            completed_at: j.completed_at ?? null,
            url: j.html_url ?? "",
            run_id: j.run_id,
          })),
          truncated: page.truncated,
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
        const body: { ref: string; inputs?: Record<string, string | number | boolean> } = {
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
