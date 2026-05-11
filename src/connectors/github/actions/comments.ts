/**
 * Comment action specs — six actions across two distinct APIs:
 *  - Issue-conversation comments: top-level threaded comments on issues
 *    (also visible on PRs as "conversation" tab).
 *  - PR review-inline comments: file-and-line anchored comments on a PR diff.
 *
 * Delete actions carry the delete aspect.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";
import {
  issueNumberField,
  ownerRepoField,
  pullNumberField,
} from "./_fields.js";

// Local fields not shared with other modules yet.
const shaField = z.string().regex(/^[a-f0-9]{7,40}$/, "Expected a git SHA");
const pathField = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_./ -]+$/)
  .refine((p) => !p.includes(".."), { message: "Path traversal not allowed" });

const commentIdField = z.coerce.number().int().positive();

// ─── Param schemas ────────────────────────────────────────────────────────

const addIssueCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
  body: z.string().min(1),
});

const updateIssueCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: commentIdField,
  body: z.string().min(1),
});

const deleteIssueCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: commentIdField,
});

const addPrReviewCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pr_number: pullNumberField,
  body: z.string().min(1),
  commit_id: shaField,
  path: pathField,
  line: z.coerce.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  start_line: z.coerce.number().int().positive().optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
});

const updatePrReviewCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: commentIdField,
  body: z.string().min(1),
});

const deletePrReviewCommentParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  comment_id: commentIdField,
});

// ─── Envelope helpers ─────────────────────────────────────────────────────

function issueCommentEnvelope(c: {
  id: number;
  user?: { login?: string };
  body?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}) {
  return {
    comment_id: c.id,
    author: c.user?.login ?? "",
    body_markdown: c.body ?? "",
    url: c.html_url ?? "",
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
  };
}

function prReviewCommentEnvelope(c: {
  id: number;
  user?: { login?: string };
  body?: string;
  path?: string;
  line?: number | null;
  commit_id?: string;
  diff_hunk?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}) {
  return {
    comment_id: c.id,
    author: c.user?.login ?? "",
    body_markdown: c.body ?? "",
    path: c.path ?? "",
    line: c.line ?? null,
    commit_id: c.commit_id ?? "",
    diff_hunk: c.diff_hunk ?? "",
    url: c.html_url ?? "",
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
  };
}

// ─── Action factory ───────────────────────────────────────────────────────

export function buildCommentsActions(_deps: GithubActionDeps): GithubActions {
  return {
    add_issue_comment: {
      description: "Add a comment on an issue or PR conversation",
      params: addIssueCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.addIssueComment(p.owner, p.repo, p.issue_number, {
          body: p.body,
        });
        throwIfHttpError(r);
        return issueCommentEnvelope(r.data);
      },
    },

    update_issue_comment: {
      description: "Edit an existing issue/PR-conversation comment",
      params: updateIssueCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.updateIssueComment(p.owner, p.repo, p.comment_id, {
          body: p.body,
        });
        throwIfHttpError(r);
        return issueCommentEnvelope(r.data);
      },
    },

    delete_issue_comment: {
      description: "Delete an issue/PR-conversation comment",
      params: deleteIssueCommentParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deleteIssueComment(p.owner, p.repo, p.comment_id);
        throwIfHttpError(r);
        return { comment_id: p.comment_id, deleted: true };
      },
    },

    add_pr_review_comment: {
      description:
        "Add an inline review comment to a PR at a specific file/line/commit",
      params: addPrReviewCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          body: string;
          commit_id: string;
          path: string;
          line: number;
          side?: "LEFT" | "RIGHT";
          start_line?: number;
          start_side?: "LEFT" | "RIGHT";
        } = {
          body: p.body,
          commit_id: p.commit_id,
          path: p.path,
          line: p.line,
        };
        if (p.side !== undefined) body.side = p.side;
        if (p.start_line !== undefined) body.start_line = p.start_line;
        if (p.start_side !== undefined) body.start_side = p.start_side;
        const r = await ctx.sdk.addPrReviewComment(p.owner, p.repo, p.pr_number, body);
        throwIfHttpError(r);
        return prReviewCommentEnvelope(r.data);
      },
    },

    update_pr_review_comment: {
      description: "Edit an existing PR review-inline comment",
      params: updatePrReviewCommentParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.updatePrReviewComment(
          p.owner,
          p.repo,
          p.comment_id,
          { body: p.body },
        );
        throwIfHttpError(r);
        return prReviewCommentEnvelope(r.data);
      },
    },

    delete_pr_review_comment: {
      description: "Delete a PR review-inline comment",
      params: deletePrReviewCommentParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deletePrReviewComment(p.owner, p.repo, p.comment_id);
        throwIfHttpError(r);
        return { comment_id: p.comment_id, deleted: true };
      },
    },
  };
}
