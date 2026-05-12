/**
 * Issue action specs: create / update / close.
 * (get_issue is in reads.ts.)
 *
 * update_issue's zod schema rejects state_event=close so closures are
 * always routed through close_issue, which carries the delete aspect.
 * Labels are accepted as string[] in the schema and joined to CSV before
 * being sent to GitLab (which expects comma-separated labels).
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GitlabActionDeps, GitlabActions } from "./_types.js";
import type { GitlabIssue } from "../lib/gitlab_client.js";
import { namespaceField, projectField, issueIidField } from "./_fields.js";

const projectParams = z.object({
  namespace: namespaceField,
  project: projectField,
});

const createIssueParams = projectParams.extend({
  title: z.string().min(1),
  description: z.string().optional(),
  assignee_ids: z.array(z.number().int().positive()).optional(),
  labels: z.array(z.string()).optional(),
  milestone_id: z.number().int().positive().optional(),
  due_date: z.string().optional(),
});

const updateIssueParams = projectParams.extend({
  iid: issueIidField,
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  assignee_ids: z.array(z.number().int().positive()).optional(),
  labels: z.array(z.string()).optional(),
  milestone_id: z.number().int().positive().optional(),
  due_date: z.string().optional(),
  state_event: z
    .enum(["reopen"], {
      errorMap: () => ({
        message:
          "update_issue only accepts state_event=reopen. Use close_issue to close.",
      }),
    })
    .optional(),
});

const closeIssueParams = projectParams.extend({
  iid: issueIidField,
});

function issueEnvelope(d: GitlabIssue) {
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
}

export function buildIssuesActions(_deps: GitlabActionDeps): GitlabActions {
  return {
    create_issue: {
      description: "Create a new issue in a GitLab project",
      params: createIssueParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title: string;
          description?: string;
          assignee_ids?: number[];
          labels?: string;
          milestone_id?: number;
          due_date?: string;
        } = { title: p.title };
        if (p.description !== undefined) body.description = p.description;
        if (p.assignee_ids !== undefined) body.assignee_ids = p.assignee_ids;
        if (p.labels !== undefined) body.labels = p.labels.join(",");
        if (p.milestone_id !== undefined) body.milestone_id = p.milestone_id;
        if (p.due_date !== undefined) body.due_date = p.due_date;
        const r = await ctx.sdk.createIssue(p.namespace, p.project, body);
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },

    update_issue: {
      description:
        "Update a GitLab issue. Accepts state_event=reopen to reopen. Closing is a separate action.",
      params: updateIssueParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title?: string;
          description?: string;
          assignee_ids?: number[];
          labels?: string;
          milestone_id?: number;
          due_date?: string;
          state_event?: "reopen";
        } = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.description !== undefined) body.description = p.description;
        if (p.assignee_ids !== undefined) body.assignee_ids = p.assignee_ids;
        if (p.labels !== undefined) body.labels = p.labels.join(",");
        if (p.milestone_id !== undefined) body.milestone_id = p.milestone_id;
        if (p.due_date !== undefined) body.due_date = p.due_date;
        if (p.state_event !== undefined) body.state_event = p.state_event;
        const r = await ctx.sdk.updateIssue(p.namespace, p.project, p.iid, body);
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },

    close_issue: {
      description:
        "Close a GitLab issue (does not delete; REST has no hard-delete).",
      params: closeIssueParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.closeIssue(p.namespace, p.project, p.iid);
        throwIfHttpError(r);
        return {
          ...issueEnvelope(r.data),
          closed: true,
        };
      },
    },
  };
}
