/**
 * Pipeline write actions: retry, cancel, trigger, and play_job.
 * Read actions (list_pipelines, get_pipeline, list_pipeline_jobs, get_job_logs)
 * live in reads.ts.
 *
 * Note: retry_failed_jobs is an alias for retry_pipeline. GitLab's retry
 * endpoint already only re-runs failed/canceled jobs — there is no separate
 * endpoint for "retry only failed jobs".
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GitlabActionDeps, GitlabActions } from "./_types.js";
import {
  namespaceField,
  projectField,
  pipelineIdField,
  jobIdField,
  refField,
} from "./_fields.js";

const projectParams = z.object({
  namespace: namespaceField,
  project: projectField,
});

const pipelineActionParams = projectParams.extend({
  pipeline_id: pipelineIdField,
});

const triggerPipelineParams = projectParams.extend({
  token: z.string().min(1, "trigger_pipeline requires a non-empty 'token'"),
  ref: refField,
  variables: z.record(z.string()).optional(),
});

const playJobParams = projectParams.extend({
  job_id: jobIdField,
  variables: z.record(z.string()).optional(),
});

export function buildPipelinesActions(_deps: GitlabActionDeps): GitlabActions {
  return {
    retry_pipeline: {
      description:
        "Retry a GitLab pipeline — re-runs all failed and canceled jobs. Returns the updated pipeline.",
      params: pipelineActionParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.retryPipeline(p.namespace, p.project, p.pipeline_id);
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          status: d.status,
          ref: d.ref,
          sha: d.sha ?? "",
          web_url: d.web_url ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
        };
      },
    },

    retry_failed_jobs: {
      description:
        "Retry only failed/canceled jobs in a GitLab pipeline. This is an alias for retry_pipeline — GitLab's POST /pipelines/:id/retry endpoint already only re-runs failed and canceled jobs. Returns the updated pipeline.",
      params: pipelineActionParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.retryPipeline(p.namespace, p.project, p.pipeline_id);
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          status: d.status,
          ref: d.ref,
          sha: d.sha ?? "",
          web_url: d.web_url ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
        };
      },
    },

    cancel_pipeline: {
      description:
        "Cancel a running GitLab pipeline. Returns the canceled pipeline.",
      params: pipelineActionParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.cancelPipeline(p.namespace, p.project, p.pipeline_id);
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          status: d.status,
          ref: d.ref,
          sha: d.sha ?? "",
          web_url: d.web_url ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
        };
      },
    },

    trigger_pipeline: {
      description:
        "Trigger a new GitLab pipeline using a trigger token (not a PAT). Requires 'token' (a pipeline trigger token) and 'ref' (branch/tag). Optional 'variables' map is passed as pipeline variables. Returns the newly created pipeline.",
      params: triggerPipelineParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: { token: string; ref: string; variables?: Record<string, string> } = {
          token: p.token,
          ref: p.ref,
        };
        if (p.variables !== undefined) body.variables = p.variables;
        const r = await ctx.sdk.triggerPipeline(p.namespace, p.project, body);
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          status: d.status,
          ref: d.ref,
          sha: d.sha ?? "",
          web_url: d.web_url ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
        };
      },
    },

    play_job: {
      description:
        "Play (start) a manual GitLab CI job. Used for jobs in a manual stage that need explicit triggering. Optional 'variables' overrides inline job variables. Returns the started job.",
      params: playJobParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.playJob(p.namespace, p.project, p.job_id, p.variables);
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          name: d.name,
          stage: d.stage ?? "",
          status: d.status,
          web_url: d.web_url ?? "",
          created_at: d.created_at ?? null,
          started_at: d.started_at ?? null,
          finished_at: d.finished_at ?? null,
          duration: d.duration ?? null,
        };
      },
    },
  };
}
