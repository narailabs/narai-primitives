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
  assertValidAdf,
  checkPathContainment,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { markdownToAdf } from "marklassian";
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

const issueKeyRe = /^[A-Z][A-Z0-9]+-\d+$/;
const issueKeySchema = z
  .string()
  .regex(issueKeyRe, "Invalid issue_key — expected format like PROJ-123");
const projectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+$/, "Invalid project_key — expected format like PROJ");

const getIssueParams = z.object({
  issue_key: issueKeySchema,
  expand: z.array(z.string()).default([]),
});

const getProjectParams = z.object({
  project_key: projectKeySchema,
});

const listAttachmentsParams = z.object({
  issue_key: issueKeySchema,
});

const getAttachmentParams = z.object({
  issue_key: issueKeySchema,
  attachment_id: z.string().min(1, "attachment_id is required"),
});

const getCommentsParams = z.object({
  issue_key: issueKeySchema,
  max_results: z.coerce.number().int().positive().default(50),
});

// ── Write-action param schemas ───────────────────────────────────────────────

const contentInput = z.union([
  z.object({ format: z.literal("adf"), value: z.unknown() }),
  z.object({ format: z.literal("markdown"), value: z.string() }),
  z.object({ format: z.literal("plain"), value: z.string() }),
]);

const createIssueParams = z.object({
  project_key: projectKeySchema,
  issue_type: z.string().min(1),
  summary: z.string().min(1),
  description: contentInput.optional(),
  labels: z.array(z.string()).optional(),
  assignee_account_id: z.string().optional(),
  parent_key: issueKeySchema.optional(),
});

const updateIssueParams = z.object({
  issue_key: issueKeySchema,
  summary: z.string().min(1).optional(),
  description: contentInput.optional(),
  labels: z.array(z.string()).optional(),
  assignee_account_id: z.string().optional(),
});

const deleteIssueParams = z.object({
  issue_key: issueKeySchema,
});

const addCommentParams = z.object({
  issue_key: issueKeySchema,
  body: contentInput,
});

const updateCommentParams = z.object({
  issue_key: issueKeySchema,
  comment_id: z.string().min(1),
  body: contentInput,
});

const deleteCommentParams = z.object({
  issue_key: issueKeySchema,
  comment_id: z.string().min(1),
});

const transitionIssueParams = z.object({
  issue_key: issueKeySchema,
  transition_id: z.string().min(1),
  comment: contentInput.optional(),
});

const fileInput = z.union([
  z.object({
    filename: z.string(),
    content_base64: z.string(),
    mime_type: z.string().optional(),
  }),
  z.object({
    filename: z.string().optional(),
    path: z.string(),
    mime_type: z.string().optional(),
  }),
]);

const postAttachmentParams = z.object({
  issue_key: issueKeySchema,
  files: z.array(fileInput).min(1),
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
  VALIDATION_ERROR: "VALIDATION_ERROR",
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
// ADF conversion helper
// ───────────────────────────────────────────────────────────────────────────

type ContentInput = z.infer<typeof contentInput>;

function resolveContentToAdf(input: ContentInput): unknown {
  if (input.format === "adf") {
    return input.value;
  }
  if (input.format === "markdown") {
    return markdownToAdf(input.value);
  }
  // plain
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: input.value }],
      },
    ],
  };
}

/** Convert contentInput to ADF, asserting validity. Throws JiraError on bad ADF. */
function toAdf(input: ContentInput): unknown {
  const doc = resolveContentToAdf(input);
  try {
    assertValidAdf(doc);
  } catch (e) {
    throw new JiraError(
      "VALIDATION_ERROR",
      e instanceof Error ? e.message : String(e),
      false,
      400,
    );
  }
  return doc;
}

// Inline MIME map for attachment path inputs.
const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<JiraClient>;
  credentials?: () => Promise<Record<string, unknown>>;
  /** Override the default policy rules (used in tests). */
  defaultPolicy?: import("narai-primitives/toolkit").PolicyRules;
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
          "narai-primitives/credentials).",
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
    ...(overrides.defaultPolicy !== undefined
      ? { defaultPolicy: overrides.defaultPolicy }
      : {}),
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
      create_issue: {
        description: "Create a new Jira issue",
        params: createIssueParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof createIssueParams>, ctx) => {
          const fields: Record<string, unknown> = {
            project: { key: p.project_key },
            issuetype: { name: p.issue_type },
            summary: p.summary,
          };
          if (p.description !== undefined) {
            fields["description"] = toAdf(p.description);
          }
          if (p.labels !== undefined) fields["labels"] = p.labels;
          if (p.assignee_account_id !== undefined) {
            fields["assignee"] = { accountId: p.assignee_account_id };
          }
          if (p.parent_key !== undefined) {
            fields["parent"] = { key: p.parent_key };
          }
          const result = await ctx.sdk.createIssue({ fields });
          throwIfError(result);
          return {
            key: result.data.key,
            id: result.data.id,
            self: result.data.self,
          };
        },
      },
      update_issue: {
        description: "Update fields on an existing Jira issue",
        params: updateIssueParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof updateIssueParams>, ctx) => {
          const fields: Record<string, unknown> = {};
          if (p.summary !== undefined) fields["summary"] = p.summary;
          if (p.description !== undefined) {
            fields["description"] = toAdf(p.description);
          }
          if (p.labels !== undefined) fields["labels"] = p.labels;
          if (p.assignee_account_id !== undefined) {
            fields["assignee"] = { accountId: p.assignee_account_id };
          }
          const result = await ctx.sdk.updateIssue(p.issue_key, { fields });
          throwIfError(result);
          return { key: p.issue_key, updated: true };
        },
      },
      delete_issue: {
        description: "Delete a Jira issue",
        params: deleteIssueParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof deleteIssueParams>, ctx) => {
          const result = await ctx.sdk.deleteIssue(p.issue_key);
          throwIfError(result);
          return { key: p.issue_key, deleted: true };
        },
      },
      add_comment: {
        description: "Add a comment to a Jira issue",
        params: addCommentParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof addCommentParams>, ctx) => {
          const body = toAdf(p.body);
          const result = await ctx.sdk.addComment(p.issue_key, { body });
          throwIfError(result);
          const r = result.data;
          return {
            comment_id: r.id,
            created: r.created ?? null,
            author: r.author?.displayName ?? null,
          };
        },
      },
      update_comment: {
        description: "Update an existing comment on a Jira issue",
        params: updateCommentParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof updateCommentParams>, ctx) => {
          const body = toAdf(p.body);
          const result = await ctx.sdk.updateComment(p.issue_key, p.comment_id, {
            body,
          });
          throwIfError(result);
          const r = result.data;
          return {
            comment_id: r.id,
            updated: r.updated ?? null,
            author: r.author?.displayName ?? null,
          };
        },
      },
      delete_comment: {
        description: "Delete a comment from a Jira issue",
        params: deleteCommentParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof deleteCommentParams>, ctx) => {
          const result = await ctx.sdk.deleteComment(p.issue_key, p.comment_id);
          throwIfError(result);
          return { comment_id: p.comment_id, deleted: true };
        },
      },
      transition_issue: {
        description: "Transition a Jira issue to a new status",
        params: transitionIssueParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof transitionIssueParams>, ctx) => {
          const payload: Record<string, unknown> = {
            transition: { id: p.transition_id },
          };
          if (p.comment !== undefined) {
            payload["update"] = {
              comment: [{ add: { body: toAdf(p.comment) } }],
            };
          }
          const result = await ctx.sdk.transitionIssue(p.issue_key, payload);
          throwIfError(result);
          return { issue_key: p.issue_key, transitioned: true };
        },
      },
      post_attachment: {
        description: "Upload one or more files as attachments to a Jira issue",
        params: postAttachmentParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof postAttachmentParams>, ctx) => {
          const files: Array<{
            filename: string;
            bytes: Uint8Array;
            mimeType?: string;
          }> = [];
          for (const f of p.files) {
            if ("content_base64" in f) {
              const entry: { filename: string; bytes: Uint8Array; mimeType?: string } = {
                filename: f.filename,
                bytes: new Uint8Array(Buffer.from(f.content_base64, "base64")),
              };
              if (f.mime_type !== undefined) entry.mimeType = f.mime_type;
              files.push(entry);
            } else {
              if (!checkPathContainment(f.path, process.cwd())) {
                throw new JiraError(
                  "VALIDATION_ERROR",
                  `Path '${f.path}' escapes working directory`,
                  false,
                  400,
                );
              }
              const bytes = new Uint8Array(fs.readFileSync(f.path));
              const filename = f.filename ?? path.basename(f.path);
              const ext = path.extname(f.path).toLowerCase();
              const mimeType = f.mime_type ?? EXT_MIME[ext];
              const entry: { filename: string; bytes: Uint8Array; mimeType?: string } = {
                filename,
                bytes,
              };
              if (mimeType !== undefined) entry.mimeType = mimeType;
              files.push(entry);
            }
          }
          const result = await ctx.sdk.postAttachment(p.issue_key, files);
          throwIfError(result);
          const attachments = Array.isArray(result.data) ? result.data : [];
          return {
            issue_key: p.issue_key,
            attachments: attachments.map((a) => ({
              attachment_id: a.id,
              filename: a.filename ?? "",
              media_type: a.mimeType ?? "application/octet-stream",
              size_bytes: a.size ?? 0,
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
