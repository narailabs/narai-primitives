/**
 * Read-only actions on the GitLab connector. All 14 actions have
 * classify `{ kind: "read" }`.
 *
 * Pagination: listing endpoints use paginateGitlab, which walks
 * page=1,2,3... until max_results is reached or a short page terminates.
 * HTTP errors propagate as ConnectorError via `throwIfHttpError`.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GitlabActionDeps, GitlabActions } from "./_types.js";
import {
  namespaceField,
  projectField,
  issueIidField,
  mrIidField,
  pipelineIdField,
  jobIdField,
  linkIdField,
  releaseTagField,
  refField,
  filePathField,
} from "./_fields.js";
import { paginateGitlab, MAX_RESULTS_DEFAULT, MAX_RESULTS_CAP } from "./_pagination.js";

// ── Param schemas ──────────────────────────────────────────────────────────

const projectParams = z.object({
  namespace: namespaceField,
  project: projectField,
});

const searchCodeParams = projectParams.extend({
  query: z.string().min(1, "search_code requires a non-empty 'query' string"),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const VALID_STATES = z.enum(["opened", "closed", "all"]);

const listIssuesParams = projectParams.extend({
  state: VALID_STATES.default("opened"),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getIssueParams = projectParams.extend({
  iid: issueIidField,
});

const listMrsParams = projectParams.extend({
  state: VALID_STATES.default("opened"),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getMrParams = projectParams.extend({
  iid: mrIidField,
});

const getFileParams = projectParams.extend({
  path: filePathField,
  ref: refField.default("main"),
});

const getNotesParams = projectParams.extend({
  noteable_type: z.enum(["issue", "merge_request"]),
  noteable_iid: z.coerce.number().int().positive(),
});

const listReleaseLinksParams = projectParams.extend({
  tag: releaseTagField,
});

const getReleaseLinkParams = projectParams.extend({
  tag: releaseTagField,
  link_id: linkIdField,
});

const listPipelinesParams = projectParams.extend({
  ref: refField.optional(),
  status: z.string().optional(),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getPipelineParams = projectParams.extend({
  pipeline_id: pipelineIdField,
});

const listPipelineJobsParams = projectParams.extend({
  pipeline_id: pipelineIdField,
});

const getJobLogsParams = projectParams.extend({
  job_id: jobIdField,
});

// ── Factory ────────────────────────────────────────────────────────────────

export function buildReadActions(_deps: GitlabActionDeps): GitlabActions {
  return {
    project_info: {
      description: "Fetch GitLab project metadata",
      params: projectParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof projectParams>, ctx) => {
        const result = await ctx.sdk.getProject(p.namespace, p.project);
        throwIfHttpError(result);
        const d = result.data;
        return {
          id: d.id,
          name: d.name,
          path_with_namespace: d.path_with_namespace,
          default_branch: d.default_branch ?? "main",
          description: d.description ?? "",
          visibility: d.visibility ?? null,
          web_url: d.web_url ?? "",
          ssh_url_to_repo: d.ssh_url_to_repo ?? "",
          http_url_to_repo: d.http_url_to_repo ?? "",
        };
      },
    },

    search_code: {
      description: "Search code in a GitLab project (scope=blobs)",
      params: searchCodeParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof searchCodeParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginateGitlab(limit, (pageNum, perPage) =>
          ctx.sdk.searchCode(p.namespace, p.project, p.query, { page: pageNum, perPage }),
        );
        return {
          total: page.items.length,
          items: page.items.map((it) => ({
            path: it.path,
            filename: it.filename,
            ref: it.ref,
            startline: it.startline,
          })),
          truncated: page.truncated,
        };
      },
    },

    get_issues: {
      description: "List issues in a GitLab project, paginated up to max_results",
      params: listIssuesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listIssuesParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginateGitlab(limit, (pageNum, perPage) =>
          ctx.sdk.listIssues(p.namespace, p.project, {
            state: p.state,
            per_page: perPage,
            page: pageNum,
          }),
        );
        return {
          total: page.items.length,
          issues: page.items.map((i) => ({
            iid: i.iid,
            title: i.title,
            state: i.state,
            author: i.author?.username ?? "",
            labels: i.labels ?? [],
            web_url: i.web_url ?? "",
            updated_at: i.updated_at ?? null,
          })),
          truncated: page.truncated,
        };
      },
    },

    get_issue: {
      description: "Fetch a single GitLab issue by IID",
      params: getIssueParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getIssueParams>, ctx) => {
        const result = await ctx.sdk.getIssue(p.namespace, p.project, p.iid);
        throwIfHttpError(result);
        const d = result.data;
        return {
          iid: d.iid,
          title: d.title,
          state: d.state,
          author: d.author?.username ?? "",
          description: d.description ?? "",
          labels: d.labels ?? [],
          web_url: d.web_url ?? "",
          updated_at: d.updated_at ?? null,
        };
      },
    },

    get_merge_requests: {
      description: "List merge requests in a GitLab project, paginated up to max_results",
      params: listMrsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listMrsParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginateGitlab(limit, (pageNum, perPage) =>
          ctx.sdk.listMergeRequests(p.namespace, p.project, {
            state: p.state,
            per_page: perPage,
            page: pageNum,
          }),
        );
        return {
          total: page.items.length,
          merge_requests: page.items.map((mr) => ({
            iid: mr.iid,
            title: mr.title,
            state: mr.state,
            author: mr.author?.username ?? "",
            web_url: mr.web_url ?? "",
            updated_at: mr.updated_at ?? null,
          })),
          truncated: page.truncated,
        };
      },
    },

    get_merge_request: {
      description: "Fetch a single GitLab merge request by IID",
      params: getMrParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getMrParams>, ctx) => {
        const result = await ctx.sdk.getMergeRequest(p.namespace, p.project, p.iid);
        throwIfHttpError(result);
        const d = result.data;
        return {
          iid: d.iid,
          title: d.title,
          state: d.state,
          author: d.author?.username ?? "",
          description: d.description ?? "",
          source_branch: d.source_branch ?? "",
          target_branch: d.target_branch ?? "",
          sha: d.sha ?? "",
          draft: d.draft ?? false,
          web_url: d.web_url ?? "",
          updated_at: d.updated_at ?? null,
        };
      },
    },

    get_file: {
      description: "Fetch a file's contents at a given ref from a GitLab project",
      params: getFileParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getFileParams>, ctx) => {
        const result = await ctx.sdk.getFile(p.namespace, p.project, p.path, p.ref);
        throwIfHttpError(result);
        const d = result.data;
        let decoded = "";
        if (d.encoding === "base64" && d.content) {
          decoded = Buffer.from(d.content, "base64").toString("utf-8");
        }
        return {
          path: d.file_path,
          ref: d.ref,
          size_bytes: d.size ?? 0,
          content: decoded,
          encoding: "utf-8",
        };
      },
    },

    get_notes: {
      description: "List notes (comments) on a GitLab issue or merge request",
      params: getNotesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getNotesParams>, ctx) => {
        const result = await ctx.sdk.getNotes(
          p.namespace,
          p.project,
          p.noteable_type,
          p.noteable_iid,
        );
        throwIfHttpError(result);
        const notes = result.data ?? [];
        return {
          noteable_type: p.noteable_type,
          noteable_iid: p.noteable_iid,
          total: notes.length,
          notes: notes.map((n) => ({
            id: n.id,
            body: n.body,
            author: n.author?.username ?? "",
            created_at: n.created_at ?? null,
            updated_at: n.updated_at ?? null,
            system: n.system ?? false,
          })),
        };
      },
    },

    list_release_links: {
      description: "List asset links for a GitLab release by tag",
      params: listReleaseLinksParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listReleaseLinksParams>, ctx) => {
        const result = await ctx.sdk.listReleaseLinks(p.namespace, p.project, p.tag);
        throwIfHttpError(result);
        const links = result.data ?? [];
        return {
          tag: p.tag,
          total: links.length,
          links: links.map((l) => ({
            id: l.id,
            name: l.name,
            url: l.url,
            link_type: l.link_type ?? null,
          })),
        };
      },
    },

    get_release_link: {
      description: "Fetch a single GitLab release asset link by ID",
      params: getReleaseLinkParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getReleaseLinkParams>, ctx) => {
        const result = await ctx.sdk.getReleaseLink(
          p.namespace,
          p.project,
          p.tag,
          p.link_id,
        );
        throwIfHttpError(result);
        const d = result.data;
        return {
          id: d.id,
          name: d.name,
          url: d.url,
          link_type: d.link_type ?? null,
          tag: p.tag,
        };
      },
    },

    list_pipelines: {
      description: "List pipelines in a GitLab project, paginated up to max_results",
      params: listPipelinesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listPipelinesParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginateGitlab(limit, (pageNum, perPage) => {
          const q: Parameters<typeof ctx.sdk.listPipelines>[2] = {
            per_page: perPage,
            page: pageNum,
          };
          if (p.ref !== undefined) q.ref = p.ref;
          if (p.status !== undefined) q.status = p.status;
          return ctx.sdk.listPipelines(p.namespace, p.project, q);
        });
        return {
          total: page.items.length,
          pipelines: page.items.map((pl) => ({
            id: pl.id,
            status: pl.status,
            ref: pl.ref,
            sha: pl.sha ?? "",
            web_url: pl.web_url ?? "",
            created_at: pl.created_at ?? null,
            updated_at: pl.updated_at ?? null,
          })),
          truncated: page.truncated,
        };
      },
    },

    get_pipeline: {
      description: "Fetch a single GitLab pipeline by ID",
      params: getPipelineParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getPipelineParams>, ctx) => {
        const result = await ctx.sdk.getPipeline(p.namespace, p.project, p.pipeline_id);
        throwIfHttpError(result);
        const d = result.data;
        return {
          id: d.id,
          status: d.status,
          ref: d.ref,
          sha: d.sha ?? "",
          web_url: d.web_url ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
          duration: d.duration ?? null,
          finished_at: d.finished_at ?? null,
        };
      },
    },

    list_pipeline_jobs: {
      description: "List jobs for a GitLab pipeline",
      params: listPipelineJobsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listPipelineJobsParams>, ctx) => {
        const result = await ctx.sdk.listPipelineJobs(
          p.namespace,
          p.project,
          p.pipeline_id,
        );
        throwIfHttpError(result);
        const jobs = result.data ?? [];
        return {
          pipeline_id: p.pipeline_id,
          total: jobs.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            stage: j.stage ?? "",
            status: j.status,
            created_at: j.created_at ?? null,
            started_at: j.started_at ?? null,
            finished_at: j.finished_at ?? null,
            duration: j.duration ?? null,
            web_url: j.web_url ?? "",
          })),
        };
      },
    },

    get_job_logs: {
      description: "Fetch the trace log for a GitLab CI job",
      params: getJobLogsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getJobLogsParams>, ctx) => {
        const result = await ctx.sdk.getJobLogs(p.namespace, p.project, p.job_id);
        throwIfHttpError(result);
        const logs = typeof result.data === "string" ? result.data : "";
        return {
          job_id: p.job_id,
          logs,
          content_length: logs.length,
        };
      },
    },
  };
}
