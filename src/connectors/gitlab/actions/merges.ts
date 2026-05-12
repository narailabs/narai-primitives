/**
 * Merge-request action specs: create / update / close / merge.
 *
 * Classification:
 *   - create_merge_request : write   (require_draft_mr forces draft=true)
 *   - update_merge_request : write   (schema rejects state_event=close)
 *   - close_merge_request  : write + delete aspect
 *   - merge_merge_request  : admin   (operator opt-in via YAML)
 *
 * 405/406/409-on-merge: GitLab returns these when the MR is not in a
 * mergeable state, pipeline gate fails, or the SHA changed. We surface
 * them as a VALIDATION_ERROR via the CONFLICT code (mapped in Task 9).
 */
import { ConnectorError, throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GitlabActionDeps, GitlabActions } from "./_types.js";
import type { GitlabMergeRequest } from "../lib/gitlab_client.js";
import {
  namespaceField,
  projectField,
  mrIidField,
  refField,
  shaField,
} from "./_fields.js";

const createMrParams = z.object({
  namespace: namespaceField,
  project: projectField,
  source_branch: refField,
  target_branch: refField,
  title: z.string().min(1),
  description: z.string().optional(),
  assignee_ids: z.array(z.number().int().positive()).optional(),
  reviewer_ids: z.array(z.number().int().positive()).optional(),
  labels: z.string().optional(),
  milestone_id: z.number().int().positive().optional(),
  remove_source_branch: z.boolean().optional(),
  squash: z.boolean().optional(),
  draft: z.boolean().default(false),
});

const updateMrParams = z.object({
  namespace: namespaceField,
  project: projectField,
  mr_iid: mrIidField,
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  target_branch: refField.optional(),
  assignee_ids: z.array(z.number().int().positive()).optional(),
  reviewer_ids: z.array(z.number().int().positive()).optional(),
  labels: z.string().optional(),
  milestone_id: z.number().int().positive().optional(),
  state_event: z
    .enum(["reopen"], {
      errorMap: () => ({
        message:
          "update_merge_request only accepts state_event=reopen. Use close_merge_request to close.",
      }),
    })
    .optional(),
  remove_source_branch: z.boolean().optional(),
  squash: z.boolean().optional(),
});

const closeMrParams = z.object({
  namespace: namespaceField,
  project: projectField,
  mr_iid: mrIidField,
});

const mergeMrParams = z.object({
  namespace: namespaceField,
  project: projectField,
  mr_iid: mrIidField,
  merge_commit_message: z.string().optional(),
  squash_commit_message: z.string().optional(),
  should_remove_source_branch: z.boolean().optional(),
  merge_when_pipeline_succeeds: z.boolean().optional(),
  sha: shaField.optional(),
  squash: z.boolean().optional(),
});

function mrEnvelope(d: GitlabMergeRequest) {
  return {
    iid: d.iid,
    title: d.title,
    state: d.state,
    draft: d.draft ?? false,
    author: d.author?.username ?? "",
    source_branch: d.source_branch ?? "",
    target_branch: d.target_branch ?? "",
    sha: d.sha ?? "",
    description: d.description ?? "",
    url: d.web_url ?? "",
    updated_at: d.updated_at ?? null,
  };
}

export function buildMergesActions(deps: GitlabActionDeps): GitlabActions {
  return {
    create_merge_request: {
      description:
        "Open a new merge request. Honors the require_draft_mr config knob.",
      params: createMrParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const requestedDraft = p.draft;
        const draftToUse = deps.behavior.requireDraftMr ? true : requestedDraft;
        const body: Parameters<typeof ctx.sdk.createMergeRequest>[2] = {
          source_branch: p.source_branch,
          target_branch: p.target_branch,
          title: p.title,
          draft: draftToUse,
        };
        if (p.description !== undefined) body.description = p.description;
        if (p.assignee_ids !== undefined) body.assignee_ids = p.assignee_ids;
        if (p.reviewer_ids !== undefined) body.reviewer_ids = p.reviewer_ids;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.milestone_id !== undefined) body.milestone_id = p.milestone_id;
        if (p.remove_source_branch !== undefined)
          body.remove_source_branch = p.remove_source_branch;
        if (p.squash !== undefined) body.squash = p.squash;
        const r = await ctx.sdk.createMergeRequest(p.namespace, p.project, body);
        throwIfHttpError(r);
        const envelope = mrEnvelope(r.data);
        if (deps.behavior.requireDraftMr && !requestedDraft) {
          return { ...envelope, draft_forced_by_config: true };
        }
        return envelope;
      },
    },

    update_merge_request: {
      description:
        "Update title, description, target_branch, or set state_event=reopen. Closing is a separate action.",
      params: updateMrParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: Parameters<typeof ctx.sdk.updateMergeRequest>[3] = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.description !== undefined) body.description = p.description;
        if (p.target_branch !== undefined) body.target_branch = p.target_branch;
        if (p.assignee_ids !== undefined) body.assignee_ids = p.assignee_ids;
        if (p.reviewer_ids !== undefined) body.reviewer_ids = p.reviewer_ids;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.milestone_id !== undefined) body.milestone_id = p.milestone_id;
        if (p.state_event !== undefined) body.state_event = p.state_event;
        if (p.remove_source_branch !== undefined)
          body.remove_source_branch = p.remove_source_branch;
        if (p.squash !== undefined) body.squash = p.squash;
        const r = await ctx.sdk.updateMergeRequest(
          p.namespace,
          p.project,
          p.mr_iid,
          body,
        );
        throwIfHttpError(r);
        return mrEnvelope(r.data);
      },
    },

    close_merge_request: {
      description: "Close a merge request.",
      params: closeMrParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.closeMergeRequest(
          p.namespace,
          p.project,
          p.mr_iid,
        );
        throwIfHttpError(r);
        return { ...mrEnvelope(r.data), closed: true };
      },
    },

    merge_merge_request: {
      description:
        "Merge a merge request. Admin-classified — operator must opt in via config.",
      params: mergeMrParams,
      classify: { kind: "admin" },
      handler: async (p, ctx) => {
        const body: Parameters<typeof ctx.sdk.mergeMergeRequest>[3] = {};
        if (p.merge_commit_message !== undefined)
          body.merge_commit_message = p.merge_commit_message;
        if (p.squash_commit_message !== undefined)
          body.squash_commit_message = p.squash_commit_message;
        if (p.should_remove_source_branch !== undefined)
          body.should_remove_source_branch = p.should_remove_source_branch;
        if (p.merge_when_pipeline_succeeds !== undefined)
          body.merge_when_pipeline_succeeds = p.merge_when_pipeline_succeeds;
        if (p.sha !== undefined) body.sha = p.sha;
        if (p.squash !== undefined) body.squash = p.squash;
        const r = await ctx.sdk.mergeMergeRequest(
          p.namespace,
          p.project,
          p.mr_iid,
          body,
        );
        if (!r.ok && (r.status === 405 || r.status === 406 || r.status === 409)) {
          throw new ConnectorError(
            "CONFLICT",
            `merge_merge_request: MR not mergeable (${r.message})`,
            false,
          );
        }
        throwIfHttpError(r);
        return {
          namespace: p.namespace,
          project: p.project,
          mr_iid: p.mr_iid,
          merged: r.data.merged,
          merge_sha: r.data.sha,
          message: r.data.message,
        };
      },
    },
  };
}
