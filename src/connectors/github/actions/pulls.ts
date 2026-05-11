/**
 * Pull-request action specs: get / create / update / close / merge.
 *
 * Classification:
 *   - get_pull_request    : read
 *   - create_pull_request : write    (require_draft_pr forces draft=true)
 *   - update_pull_request : write    (schema rejects state=closed)
 *   - close_pull_request  : write + delete aspect
 *   - merge_pull_request  : admin    (operator opt-in via YAML)
 *
 * 409-on-merge: GitHub returns 409 when the head SHA changed between
 * the caller's read and our PUT. We surface that as a VALIDATION_ERROR
 * via a connector-local CONFLICT code (mapped in index.ts CODE_MAP).
 */
import { ConnectorError, throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const ownerRepoField = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "owner/repo: alphanumeric, dots, dashes, underscores only",
  );

const pullNumberField = z.coerce.number().int().positive();

const branchField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/+-]+$/, "Invalid branch name");

const getPullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
});

const createPullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  title: z.string().min(1),
  head: branchField,
  base: branchField,
  body: z.string().optional(),
  draft: z.boolean().default(false),
  maintainer_can_modify: z.boolean().optional(),
});

const updatePullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  base: branchField.optional(),
  maintainer_can_modify: z.boolean().optional(),
  state: z
    .enum(["open"], {
      errorMap: () => ({
        message:
          "update_pull_request only accepts state=open. Use close_pull_request to close.",
      }),
    })
    .optional(),
});

const closePullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
});

const mergeMethodField = z.enum(["merge", "squash", "rebase"]);

const mergePullParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pull_number: pullNumberField,
  merge_method: mergeMethodField.default("merge"),
  commit_title: z.string().optional(),
  commit_message: z.string().optional(),
  sha: z.string().optional(),
});

function pullEnvelope(d: {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  user?: { login: string };
  base?: { ref: string; sha: string };
  head?: { ref: string; sha: string };
  html_url?: string;
  body?: string;
  merged?: boolean;
  mergeable?: boolean | null;
  updated_at?: string;
}) {
  return {
    number: d.number,
    title: d.title,
    state: d.state,
    draft: d.draft ?? false,
    author: d.user?.login ?? "",
    base_ref: d.base?.ref ?? "",
    head_ref: d.head?.ref ?? "",
    base_sha: d.base?.sha ?? "",
    head_sha: d.head?.sha ?? "",
    url: d.html_url ?? "",
    body_markdown: d.body ?? "",
    merged: d.merged ?? false,
    mergeable: d.mergeable ?? null,
    updated_at: d.updated_at ?? null,
  };
}

export function buildPullsActions(deps: GithubActionDeps): GithubActions {
  return {
    get_pull_request: {
      description: "Fetch a single pull request by number",
      params: getPullParams,
      classify: { kind: "read" },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.getPull(p.owner, p.repo, p.pull_number);
        throwIfHttpError(r);
        return pullEnvelope(r.data);
      },
    },
    create_pull_request: {
      description:
        "Open a new pull request. Honors the require_draft_pr config knob.",
      params: createPullParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const requestedDraft = p.draft;
        const draftToUse = deps.behavior.requireDraftPr ? true : requestedDraft;
        const body: {
          title: string;
          head: string;
          base: string;
          body?: string;
          draft?: boolean;
          maintainer_can_modify?: boolean;
        } = {
          title: p.title,
          head: p.head,
          base: p.base,
          draft: draftToUse,
        };
        if (p.body !== undefined) body.body = p.body;
        if (p.maintainer_can_modify !== undefined)
          body.maintainer_can_modify = p.maintainer_can_modify;
        const r = await ctx.sdk.createPull(p.owner, p.repo, body);
        throwIfHttpError(r);
        return {
          ...pullEnvelope(r.data),
          draft_forced_by_config:
            deps.behavior.requireDraftPr && !requestedDraft,
        };
      },
    },
    update_pull_request: {
      description:
        "Update title, body, base, or set state=open (reopen). Closing is a separate action.",
      params: updatePullParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          title?: string;
          body?: string;
          state?: "open";
          base?: string;
          maintainer_can_modify?: boolean;
        } = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.body !== undefined) body.body = p.body;
        if (p.state !== undefined) body.state = p.state;
        if (p.base !== undefined) body.base = p.base;
        if (p.maintainer_can_modify !== undefined)
          body.maintainer_can_modify = p.maintainer_can_modify;
        const r = await ctx.sdk.updatePull(p.owner, p.repo, p.pull_number, body);
        throwIfHttpError(r);
        return pullEnvelope(r.data);
      },
    },
    close_pull_request: {
      description: "Close a pull request (does not delete; GitHub has no REST hard-delete).",
      params: closePullParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.closePull(p.owner, p.repo, p.pull_number);
        throwIfHttpError(r);
        return {
          ...pullEnvelope(r.data),
          closed: true,
        };
      },
    },
    merge_pull_request: {
      description:
        "Merge a pull request. Admin-classified — operator must opt in via ~/.github-agent/config.yaml.",
      params: mergePullParams,
      classify: { kind: "admin" },
      handler: async (p, ctx) => {
        const body: {
          merge_method: "merge" | "squash" | "rebase";
          commit_title?: string;
          commit_message?: string;
          sha?: string;
        } = { merge_method: p.merge_method };
        if (p.commit_title !== undefined) body.commit_title = p.commit_title;
        if (p.commit_message !== undefined)
          body.commit_message = p.commit_message;
        if (p.sha !== undefined) body.sha = p.sha;
        const r = await ctx.sdk.mergePull(
          p.owner,
          p.repo,
          p.pull_number,
          body,
        );
        if (!r.ok && r.status === 409) {
          throw new ConnectorError(
            "CONFLICT",
            `merge_pull_request: head SHA changed mid-merge (${r.message})`,
            false,
          );
        }
        throwIfHttpError(r);
        return {
          owner: p.owner,
          repo: p.repo,
          pull_number: p.pull_number,
          merged: r.data.merged,
          merge_sha: r.data.sha,
          message: r.data.message,
        };
      },
    },
  };
}
