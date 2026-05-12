/**
 * Read-only actions on the GitHub connector. Lifted out of the original
 * single-file index.ts. Each action's classify is `{ kind: "read" }`.
 *
 * Pagination: the listing endpoints walk `page=1,2,3...` until either
 * max_results is reached or a short page terminates the listing. HTTP
 * errors propagate as ConnectorError via `throwIfHttpError`, which the
 * connector factory's `mapError` translates per CODE_MAP.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  extractBinary,
  FORMAT_MAP,
  sanitizeLabel,
  throwIfHttpError,
} from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";
import { ownerRepoField, issueNumberField, tagField } from "./_fields.js";
import { paginate } from "./_pagination.js";

const MAX_RESULTS_DEFAULT = 30;
const MAX_RESULTS_CAP = 1000;

const repoInfoParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
});

const searchCodeParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  query: z.string().min(1, "search_code requires a non-empty 'query' string"),
  max_results: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_RESULTS_DEFAULT),
});

const VALID_STATES = z.enum(["open", "closed", "all"]);

const getIssuesParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  state: VALID_STATES.default("open"),
  labels: z.array(z.string()).default([]),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getPullsParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  state: VALID_STATES.default("open"),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getFileParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  path: z
    .string()
    .min(1, "get_file requires a non-empty 'path'")
    .regex(
      /^[a-zA-Z0-9_./ -]+$/,
      "Invalid path — must be a valid file path",
    )
    .refine((p) => !p.includes(".."), {
      message: "Path traversal not allowed — '..' is forbidden",
    }),
  ref: z.string().default("main"),
});

const getIssueCommentsParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  issue_number: issueNumberField,
});

const getPrReviewCommentsParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  pr_number: issueNumberField,
});

const listReleaseAssetsParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  tag: tagField,
});

const getReleaseAssetParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  asset_id: z.coerce.number().int().positive(),
});

export function buildReadActions(_deps: GithubActionDeps): GithubActions {
  return {
    repo_info: {
      description: "Fetch repository metadata",
      params: repoInfoParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof repoInfoParams>, ctx) => {
        const result = await ctx.sdk.getRepo(p.owner, p.repo);
        throwIfHttpError(result);
        const data = result.data;
        return {
          full_name: data.full_name,
          description: data.description ?? "",
          default_branch: data.default_branch ?? "main",
          language: data.language ?? null,
          stars: data.stargazers_count ?? 0,
          open_issues: data.open_issues_count ?? 0,
          topics: data.topics ?? [],
          updated_at: data.updated_at ?? null,
        };
      },
    },
    search_code: {
      description: "Search code in a repo via GitHub's code-search API",
      params: searchCodeParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof searchCodeParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const result = await ctx.sdk.searchCode(p.owner, p.repo, p.query, limit);
        throwIfHttpError(result);
        const data = result.data;
        return {
          total: data.total_count ?? 0,
          items: (data.items ?? []).map((it) => ({
            path: it.path,
            repo: it.repository?.full_name ?? "",
            url: it.html_url ?? "",
          })),
          truncated: (data.total_count ?? 0) > limit,
        };
      },
    },
    get_issues: {
      description: "List issues, paginated up to max_results",
      params: getIssuesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getIssuesParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginate(limit, (pageNum, perPage) =>
          ctx.sdk.listIssues(p.owner, p.repo, {
            state: p.state,
            labels: p.labels,
            perPage,
            page: pageNum,
          }),
        );
        return {
          total: page.items.length,
          issues: page.items.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            author: i.user?.login ?? "",
            labels: (i.labels ?? []).map((l) =>
              typeof l === "string" ? l : l.name ?? "",
            ),
            url: i.html_url ?? "",
            updated_at: i.updated_at ?? null,
          })),
          truncated: page.truncated,
        };
      },
    },
    get_pulls: {
      description: "List pull requests, paginated up to max_results",
      params: getPullsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getPullsParams>, ctx) => {
        const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
        const page = await paginate(limit, (pageNum, perPage) =>
          ctx.sdk.listPulls(p.owner, p.repo, {
            state: p.state,
            perPage,
            page: pageNum,
          }),
        );
        return {
          total: page.items.length,
          pulls: page.items.map((pp) => ({
            number: pp.number,
            title: pp.title,
            state: pp.state,
            author: pp.user?.login ?? "",
            url: pp.html_url ?? "",
            updated_at: pp.updated_at ?? null,
          })),
          truncated: page.truncated,
        };
      },
    },
    get_file: {
      description: "Fetch a file's contents at a given ref",
      params: getFileParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getFileParams>, ctx) => {
        const result = await ctx.sdk.getFile(p.owner, p.repo, p.path, p.ref);
        throwIfHttpError(result);
        const data = result.data;
        let decoded = "";
        if (data.encoding === "base64" && data.content) {
          decoded = Buffer.from(data.content, "base64").toString("utf-8");
        }
        return {
          path: data.path,
          ref: p.ref,
          size_bytes: data.size ?? 0,
          content: decoded,
          encoding: "utf-8",
        };
      },
    },
    get_issue_comments: {
      description: "List comments on an issue (or PR conversation)",
      params: getIssueCommentsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getIssueCommentsParams>, ctx) => {
        const result = await ctx.sdk.getIssueComments(
          p.owner,
          p.repo,
          p.issue_number,
        );
        throwIfHttpError(result);
        return {
          owner: p.owner,
          repo: p.repo,
          issue_number: p.issue_number,
          total: result.data.results.length,
          comments: result.data.results.map((c) => ({
            comment_id: c.id,
            author: c.author,
            created_at: c.created_at,
            updated_at: c.updated_at,
            body_markdown: c.body_markdown,
            html_url: c.html_url,
          })),
        };
      },
    },
    get_pr_review_comments: {
      description: "List reviews + inline comments on a pull request",
      params: getPrReviewCommentsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getPrReviewCommentsParams>, ctx) => {
        const reviewsRes = await ctx.sdk.getPullReviews(
          p.owner,
          p.repo,
          p.pr_number,
        );
        throwIfHttpError(reviewsRes);
        const inlineRes = await ctx.sdk.getPullReviewComments(
          p.owner,
          p.repo,
          p.pr_number,
        );
        throwIfHttpError(inlineRes);
        return {
          owner: p.owner,
          repo: p.repo,
          pr_number: p.pr_number,
          reviews: reviewsRes.data.map((r) => ({
            review_id: r.id,
            author: r.author,
            state: r.state,
            submitted_at: r.submitted_at,
            body_markdown: r.body_markdown,
            html_url: r.html_url,
          })),
          inline_comments: inlineRes.data.map((c) => ({
            comment_id: c.id,
            author: c.author,
            path: c.path,
            line: c.line,
            commit_id: c.commit_id,
            created_at: c.created_at,
            body_markdown: c.body_markdown,
            diff_hunk: c.diff_hunk,
            html_url: c.html_url,
          })),
        };
      },
    },
    list_release_assets: {
      description: "List assets on a GitHub release identified by its tag",
      params: listReleaseAssetsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listReleaseAssetsParams>, ctx) => {
        const result = await ctx.sdk.listReleaseByTag(p.owner, p.repo, p.tag);
        throwIfHttpError(result);
        const rel = result.data;
        return {
          owner: p.owner,
          repo: p.repo,
          release: {
            release_id: rel.id,
            tag_name: rel.tag_name,
            name: rel.name ?? "",
            body_markdown: rel.body ?? "",
            draft: rel.draft ?? false,
            prerelease: rel.prerelease ?? false,
            published_at: rel.published_at ?? null,
            author: rel.author?.login ?? "",
          },
          assets: (rel.assets ?? []).map((a) => ({
            asset_id: a.id,
            name: a.name,
            label: a.label ?? null,
            content_type: a.content_type,
            size_bytes: a.size,
            download_count: a.download_count,
            created_at: a.created_at,
            browser_download_url: a.browser_download_url,
          })),
        };
      },
    },
    get_release_asset: {
      description:
        "Download and extract a release asset to text (PDF/DOCX/PPTX/text)",
      params: getReleaseAssetParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getReleaseAssetParams>, ctx) => {
        const dl = await ctx.sdk.getReleaseAssetDownload(
          p.owner,
          p.repo,
          p.asset_id,
        );
        throwIfHttpError(dl);
        const { bytes, contentType, filename } = dl.data;
        const ext = path.extname(filename).toLowerCase();
        const fmt = FORMAT_MAP[ext];
        let extracted: {
          format: "pdf" | "docx" | "pptx" | "text" | "skipped";
          text: string | null;
          warning?: string;
        };
        if (contentType.startsWith("text/")) {
          extracted = {
            format: "text",
            text: new TextDecoder("utf-8").decode(bytes),
          };
        } else if (fmt) {
          const tmp = path.join(
            os.tmpdir(),
            `gh-asset-${randomUUID()}${ext}`,
          );
          try {
            fs.writeFileSync(tmp, bytes);
            const r = await extractBinary(tmp, fmt);
            extracted = { format: r.format, text: r.text };
          } catch (e) {
            extracted = {
              format: "skipped",
              text: null,
              warning: e instanceof Error ? e.message : String(e),
            };
          } finally {
            try {
              fs.unlinkSync(tmp);
            } catch {
              /* best-effort */
            }
          }
        } else {
          extracted = {
            format: "skipped",
            text: null,
            warning: `Unsupported media type '${contentType}'`,
          };
        }
        const checksum = createHash("sha256").update(bytes).digest("hex");
        return {
          asset_id: p.asset_id,
          owner: p.owner,
          repo: p.repo,
          filename: sanitizeLabel(filename, 255),
          media_type: contentType,
          size_bytes: bytes.byteLength,
          checksum,
          extracted,
        };
      },
    },
  };
}
