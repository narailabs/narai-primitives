/**
 * @narai/jira-agent-connector — read-only Jira connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector` instance; `buildJiraConnector(overrides?)` is exposed for
 * tests that want to inject a fake Jira client.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createConnector,
  extractBinary,
  FORMAT_MAP,
  sanitizeLabel,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { z } from "zod";
import {
  JiraClient,
  loadJiraCredentials,
  type JiraResult,
} from "./lib/jira_client.js";
import { JiraError } from "./lib/jira_error.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_CAP = 500;

const jqlSearchParams = z.object({
  jql: z.string().min(1, "jql_search requires a non-empty 'jql' string"),
  max_results: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_RESULTS_DEFAULT),
});

const getIssueParams = z.object({
  issue_key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9]+-\d+$/,
      "Invalid issue_key — expected format like PROJ-123",
    ),
  expand: z.array(z.string()).default([]),
});

const getProjectParams = z.object({
  project_key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9]+$/,
      "Invalid project_key — expected format like PROJ",
    ),
});

const issueKeyRe = /^[A-Z][A-Z0-9]+-\d+$/;

const listAttachmentsParams = z.object({
  issue_key: z
    .string()
    .regex(issueKeyRe, "Invalid issue_key — expected format like PROJ-123"),
});

const getAttachmentParams = z.object({
  issue_key: z
    .string()
    .regex(issueKeyRe, "Invalid issue_key — expected format like PROJ-123"),
  attachment_id: z.string().min(1, "attachment_id is required"),
});

const getCommentsParams = z.object({
  issue_key: z
    .string()
    .regex(issueKeyRe, "Invalid issue_key — expected format like PROJ-123"),
  max_results: z.coerce.number().int().positive().default(50),
});

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation
// ───────────────────────────────────────────────────────────────────────────

const CODE_MAP: Record<string, ErrorCode> = {
  UNAUTHORIZED: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "CONNECTION_ERROR",
  SERVER_ERROR: "CONNECTION_ERROR",
  BAD_REQUEST: "VALIDATION_ERROR",
  INVALID_URL: "VALIDATION_ERROR",
  METHOD_NOT_ALLOWED: "VALIDATION_ERROR",
  HTTP_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
};

function throwIfError<T>(
  result: JiraResult<T>,
): asserts result is Extract<JiraResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new JiraError(
      result.code,
      result.message,
      result.retriable,
      result.status,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<JiraClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

export function buildJiraConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadJiraCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<JiraClient> => {
    const creds = await loadJiraCredentials();
    if (!creds) {
      throw new JiraError(
        "CONFIG_ERROR",
        "Jira credentials not configured. Set JIRA_SITE_URL, JIRA_EMAIL, and " +
          "JIRA_API_TOKEN (or register a credential provider via " +
          "@narai/credential-providers).",
        false,
      );
    }
    return new JiraClient(creds);
  };

  return createConnector<JiraClient>({
    name: "jira",
    version: "3.0.0",
    scope: (ctx) => ctx.sdk.siteUrl,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    actions: {
      jql_search: {
        description: "Search Jira issues with a JQL query",
        params: jqlSearchParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof jqlSearchParams>, ctx) => {
          const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
          const result = await ctx.sdk.searchJql(p.jql, limit);
          throwIfError(result);
          const total = typeof result.data.total === "number" ? result.data.total : 0;
          const issues = Array.isArray(result.data.issues)
            ? result.data.issues
            : [];
          return {
            total,
            issues: issues.slice(0, limit).map((i) => ({
              key: i.key,
              summary: i.fields?.summary ?? "",
              status: i.fields?.status?.name ?? "",
              assignee: i.fields?.assignee?.displayName ?? null,
              labels: i.fields?.labels ?? [],
              updated: i.fields?.updated ?? null,
            })),
            truncated: issues.length > limit,
          };
        },
      },
      get_issue: {
        description: "Fetch a single Jira issue by key (e.g. PROJ-123)",
        params: getIssueParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getIssueParams>, ctx) => {
          const result = await ctx.sdk.getIssue(p.issue_key, p.expand);
          throwIfError(result);
          const fields = result.data.fields ?? {};
          return {
            key: result.data.key,
            summary: fields.summary ?? "",
            status: fields.status?.name ?? "",
            assignee: fields.assignee?.displayName ?? null,
            labels: fields.labels ?? [],
            updated: fields.updated ?? null,
          };
        },
      },
      get_project: {
        description: "Fetch Jira project metadata by key (e.g. PROJ)",
        params: getProjectParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getProjectParams>, ctx) => {
          const result = await ctx.sdk.getProject(p.project_key);
          throwIfError(result);
          return {
            key: result.data.key,
            name: result.data.name ?? "",
            description: result.data.description ?? "",
            lead: result.data.lead?.displayName ?? null,
            issue_types: (result.data.issueTypes ?? []).map((t) => t.name ?? ""),
          };
        },
      },
      list_attachments: {
        description: "List attachments on a Jira issue",
        params: listAttachmentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listAttachmentsParams>, ctx) => {
          const result = await ctx.sdk.listAttachments(p.issue_key);
          throwIfError(result);
          return {
            issue_key: result.data.issueKey,
            total: result.data.results.length,
            attachments: result.data.results.map((a) => ({
              attachment_id: a.id,
              filename: a.filename,
              media_type: a.mediaType,
              size_bytes: a.sizeBytes,
              created: a.created,
              author: a.author,
            })),
          };
        },
      },
      get_attachment: {
        description: "Download and extract a Jira attachment to text",
        params: getAttachmentParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getAttachmentParams>, ctx) => {
          const list = await ctx.sdk.listAttachments(p.issue_key);
          throwIfError(list);
          const match = list.data.results.find((a) => a.id === p.attachment_id);
          if (!match) {
            throw new JiraError(
              "NOT_FOUND",
              `Attachment ${p.attachment_id} not found on issue ${p.issue_key}`,
              false,
              404,
            );
          }
          const dl = await ctx.sdk.getAttachmentDownload(p.attachment_id);
          throwIfError(dl);
          const { bytes, contentType } = dl.data;
          const filename = dl.data.filename || match.filename;
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
              `jira-attach-${randomUUID()}${ext}`,
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
            attachment_id: match.id,
            issue_key: p.issue_key,
            filename: sanitizeLabel(filename, 255),
            media_type: contentType,
            size_bytes: bytes.byteLength,
            checksum,
            extracted,
            source_url: match.contentUrl,
          };
        },
      },
      get_comments: {
        description: "List comments on a Jira issue (plain-text from ADF)",
        params: getCommentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getCommentsParams>, ctx) => {
          const result = await ctx.sdk.getComments(p.issue_key, p.max_results);
          throwIfError(result);
          return {
            issue_key: result.data.issueKey,
            total: result.data.total,
            comments: result.data.results.map((c) => ({
              comment_id: c.id,
              author: c.author,
              created: c.created,
              updated: c.updated,
              body_plain: c.body_plain,
            })),
          };
        },
      },
    },
    mapError: (err) => {
      if (err instanceof JiraError) {
        return {
          error_code: CODE_MAP[err.code] ?? "CONNECTION_ERROR",
          message: err.message,
          retriable: err.retriable,
        };
      }
      return undefined;
    },
  });
}

// Default production connector.
const connector = buildJiraConnector();
export default connector;
export const { main, fetch, validActions } = connector;

export {
  JiraClient,
  loadJiraCredentials,
  type JiraClientOptions,
  type JiraResult,
} from "./lib/jira_client.js";
export { JiraError } from "./lib/jira_error.js";
