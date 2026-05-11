/**
 * Issue action specs: get / create / update / close.
 * Close is a dedicated action carrying the delete aspect so the toolkit
 * policy gate's `aspects.delete` rule applies. update_issue's zod schema
 * forbids state=closed at parse-time to route closures through close_issue.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";
import type { GithubIssueDetail } from "../lib/github_client.js";
import { ownerRepoField, issueNumberField } from "./_fields.js";

const getIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
});

const createIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().int().positive().optional(),
});

const updateIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  state: z
    .enum(["open"], {
      errorMap: () => ({
        message:
          "update_issue only accepts state=open. Use close_issue to close.",
      }),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
});

const closeIssueParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
  state_reason: z.enum(["completed", "not_planned", "duplicate"]).optional(),
});

function issueEnvelope(d: GithubIssueDetail) {
  return {
    number: d.number,
    title: d.title,
    state: d.state,
    author: d.user?.login ?? "",
    labels: (d.labels ?? []).map((l) =>
      typeof l === "string" ? l : (l.name ?? ""),
    ),
    url: d.html_url ?? "",
    body_markdown: d.body ?? "",
    updated_at: d.updated_at ?? null,
    state_reason: d.state_reason ?? null,
  };
}

export function buildIssuesActions(_deps: GithubActionDeps): GithubActions {
  return {
    get_issue: {
      description: "Fetch a single issue by number",
      params: getIssueParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.getIssue(p.owner, p.repo, p.issue_number);
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },
    create_issue: {
      description: "Create a new issue",
      params: createIssueParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title: string;
          body?: string;
          labels?: string[];
          assignees?: string[];
          milestone?: number;
        } = { title: p.title };
        if (p.body !== undefined) body.body = p.body;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.assignees !== undefined) body.assignees = p.assignees;
        if (p.milestone !== undefined) body.milestone = p.milestone;
        const r = await ctx.sdk.createIssue(p.owner, p.repo, body);
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },
    update_issue: {
      description:
        "Update title, body, labels, assignees, or set state=open (reopen). Closing is a separate action.",
      params: updateIssueParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title?: string;
          body?: string;
          state?: "open";
          labels?: string[];
          assignees?: string[];
        } = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.body !== undefined) body.body = p.body;
        if (p.state !== undefined) body.state = p.state;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.assignees !== undefined) body.assignees = p.assignees;
        const r = await ctx.sdk.updateIssue(
          p.owner,
          p.repo,
          p.issue_number,
          body,
        );
        throwIfHttpError(r);
        return issueEnvelope(r.data);
      },
    },
    close_issue: {
      description:
        "Close an issue (does not delete; REST has no hard-delete).",
      params: closeIssueParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const body: {
          state_reason?: "completed" | "not_planned" | "duplicate";
        } = {};
        if (p.state_reason !== undefined) body.state_reason = p.state_reason;
        const r = await ctx.sdk.closeIssue(
          p.owner,
          p.repo,
          p.issue_number,
          body,
        );
        throwIfHttpError(r);
        return {
          ...issueEnvelope(r.data),
          closed: true,
        };
      },
    },
  };
}
