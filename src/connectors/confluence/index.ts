/**
 * @narai/confluence-agent-connector — Confluence connector (read + write).
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector` instance; `buildConfluenceConnector(overrides?)` is exposed
 * for tests that want to inject a fake Confluence client.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createConnector,
  ConnectorError,
  extractBinary,
  FORMAT_MAP,
  mapHttpError,
  sanitizeLabel,
  assertValidAdf,
  checkPathContainment,
  throwIfHttpError,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { markdownToAdf } from "marklassian";
import { z } from "zod";
import {
  ConfluenceClient,
  loadConfluenceCredentials,
} from "./lib/confluence_client.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const MAX_RESULTS_DEFAULT = 25;
const MAX_RESULTS_CAP = 500;

const pageIdSchema = z.string().regex(/^\d+$/, "Invalid page_id — expected numeric string");
const spaceKeySchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{1,19}$/,
    "Invalid space_key — expected uppercase alphanumeric, max 20 chars",
  );

const cqlSearchParams = z.object({
  cql: z.string().min(1, "cql_search requires a non-empty 'cql' string"),
  max_results: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_RESULTS_DEFAULT),
});

const getPageParams = z.object({
  page_id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .pipe(z.string().regex(/^\d+$/, "Invalid page_id — expected numeric ID")),
  expand: z.array(z.string()).default([]),
});

const getSpaceParams = z.object({
  space_key: spaceKeySchema,
});

const pageIdOnly = z.object({
  page_id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .pipe(z.string().regex(/^\d+$/, "Invalid page_id — expected numeric ID")),
});

const listAttachmentsParams = pageIdOnly.extend({
  limit: z.coerce.number().int().positive().default(25),
});

const getAttachmentParams = pageIdOnly.extend({
  attachment_id: z.string().min(1, "attachment_id is required"),
});

const getCommentsParams = pageIdOnly.extend({
  limit: z.coerce.number().int().positive().default(50),
});

// ── Write-action param schemas ───────────────────────────────────────────────

const contentInput = z.union([
  z.object({ format: z.literal("adf"), value: z.unknown() }),
  z.object({ format: z.literal("markdown"), value: z.string() }),
  z.object({ format: z.literal("plain"), value: z.string() }),
]);

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

const createPageParams = z.object({
  space_key: spaceKeySchema,
  title: z.string().min(1),
  body: contentInput,
  parent_id: pageIdSchema.optional(),
});

const updatePageParams = z.object({
  page_id: pageIdSchema,
  title: z.string().min(1),
  body: contentInput,
  expected_version: z.number().int().positive(),
});

const deletePageParams = z.object({
  page_id: pageIdSchema,
});

const addCommentParams = z.object({
  page_id: pageIdSchema,
  body: contentInput,
});

const postAttachmentParams = z.object({
  page_id: pageIdSchema,
  files: z.array(fileInput).min(1),
});

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation: Confluence client codes → toolkit canonical codes
// ───────────────────────────────────────────────────────────────────────────

const CODE_MAP: Record<string, ErrorCode> = {
  UNAUTHORIZED: "AUTH_ERROR",
  FORBIDDEN: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "CONNECTION_ERROR",
  SERVER_ERROR: "CONNECTION_ERROR",
  BAD_REQUEST: "VALIDATION_ERROR",
  UNPROCESSABLE: "VALIDATION_ERROR",
  INVALID_URL: "VALIDATION_ERROR",
  METHOD_NOT_ALLOWED: "VALIDATION_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  HTTP_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
};


// ───────────────────────────────────────────────────────────────────────────
// ADF conversion helper — local copy; JiraError vs ConfluenceError prevents
// sharing this with the jira connector. Keep the two in lockstep when extending.
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

/** Convert contentInput to ADF, asserting validity. Throws ConfluenceError on bad ADF. */
function toAdf(input: ContentInput): unknown {
  const doc = resolveContentToAdf(input);
  try {
    assertValidAdf(doc);
  } catch (e) {
    throw new ConnectorError(
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
  /** Inject a custom Confluence client (tests). */
  sdk?: () => Promise<ConfluenceClient>;
  /** Override credentials loader (tests). */
  credentials?: () => Promise<Record<string, unknown>>;
  /** Override the default policy rules (used in tests). */
  defaultPolicy?: import("narai-primitives/toolkit").PolicyRules;
}

export function buildConfluenceConnector(
  overrides: BuildOptions = {},
): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadConfluenceCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<ConfluenceClient> => {
    const creds = await loadConfluenceCredentials();
    if (!creds) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        "Confluence credentials not configured. Set CONFLUENCE_SITE_URL, " +
          "CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN (or register a credential " +
          "provider via narai-primitives/credentials).",
        false,
      );
    }
    return new ConfluenceClient(creds);
  };

  return createConnector<ConfluenceClient>({
    name: "confluence",
    version: "3.0.0",
    scope: (ctx) => ctx.sdk.siteUrl,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    ...(overrides.defaultPolicy !== undefined
      ? { defaultPolicy: overrides.defaultPolicy }
      : {}),
    actions: {
      cql_search: {
        description: "Search Confluence pages with a CQL query",
        params: cqlSearchParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof cqlSearchParams>, ctx) => {
          const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
          const result = await ctx.sdk.searchCql(p.cql, limit);
          throwIfHttpError(result);
          const results = Array.isArray(result.data.results)
            ? result.data.results
            : [];
          const total = result.data.totalSize ?? results.length;
          return {
            total,
            pages: results.map((page) => ({
              id: page.id,
              title: page.title ?? "",
              space_key: page.space?.key ?? "",
              version: page.version?.number ?? 0,
              last_modified: page.version?.when ?? null,
            })),
            truncated: results.length >= limit && total > results.length,
          };
        },
      },
      get_page: {
        description: "Fetch a single page by numeric id",
        params: getPageParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getPageParams>, ctx) => {
          const expand =
            p.expand.length > 0
              ? p.expand
              : ["body.storage", "space", "version"];
          const result = await ctx.sdk.getContent(p.page_id, expand);
          throwIfHttpError(result);
          const data = result.data;
          return {
            id: data.id,
            title: data.title ?? "",
            space_key: data.space?.key ?? "",
            version: data.version?.number ?? 0,
            body_markdown: data.body?.storage?.value ?? "",
            last_modified: data.version?.when ?? null,
          };
        },
      },
      get_space: {
        description: "Fetch space metadata by uppercase space_key",
        params: getSpaceParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getSpaceParams>, ctx) => {
          const result = await ctx.sdk.getSpace(p.space_key);
          throwIfHttpError(result);
          const data = result.data;
          return {
            key: data.key,
            name: data.name ?? "",
            description: data.description?.plain?.value ?? "",
            type: data.type ?? "global",
            homepage_id: data.homepage?.id ?? null,
          };
        },
      },
      list_attachments: {
        description: "List attachments on a Confluence page",
        params: listAttachmentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listAttachmentsParams>, ctx) => {
          const result = await ctx.sdk.listAttachments(p.page_id, p.limit);
          throwIfHttpError(result);
          const results = result.data.results ?? [];
          return {
            page_id: p.page_id,
            total: result.data.size ?? results.length,
            attachments: results.map((a) => ({
              attachment_id: a.id,
              filename: a.title ?? "",
              media_type: a.metadata?.mediaType ?? "application/octet-stream",
              size_bytes: a.extensions?.fileSize ?? 0,
              version: a.version?.number ?? 0,
              last_modified: a.version?.when ?? null,
              download_path: a._links?.download ?? null,
            })),
          };
        },
      },
      get_attachment: {
        description: "Download and extract a Confluence attachment to text",
        params: getAttachmentParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getAttachmentParams>, ctx) => {
          const list = await ctx.sdk.listAttachments(p.page_id, 500);
          throwIfHttpError(list);
          const match = (list.data.results ?? []).find(
            (a) => a.id === p.attachment_id,
          );
          if (!match) {
            throw new ConnectorError(
              "NOT_FOUND",
              `Attachment ${p.attachment_id} not found on page ${p.page_id}`,
              false,
              404,
            );
          }
          const downloadPath = match._links?.download;
          if (!downloadPath) {
            throw new ConnectorError(
              "BAD_REQUEST",
              `Attachment ${p.attachment_id} has no download link`,
              false,
            );
          }
          const dl = await ctx.sdk.getAttachmentDownload(downloadPath);
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
              `conf-attach-${randomUUID()}${ext}`,
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
            filename: sanitizeLabel(filename, 255),
            media_type: contentType,
            size_bytes: bytes.byteLength,
            checksum,
            extracted,
            source_url: `${ctx.sdk.siteUrl}${downloadPath}`,
          };
        },
      },
      get_comments: {
        description: "List comments on a Confluence page (plain-text body)",
        params: getCommentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getCommentsParams>, ctx) => {
          const result = await ctx.sdk.getComments(p.page_id, p.limit);
          throwIfHttpError(result);
          const results = result.data.results ?? [];
          return {
            page_id: p.page_id,
            total: result.data.size ?? results.length,
            comments: results.map((c) => ({
              comment_id: c.id,
              author: c.author,
              created: c.created,
              version: c.version,
              body_plain: c.body_plain,
            })),
          };
        },
      },
      create_page: {
        description: "Create a new Confluence page",
        params: createPageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof createPageParams>, ctx) => {
          const adf = toAdf(p.body);
          const payload: Record<string, unknown> = {
            type: "page",
            title: p.title,
            space: { key: p.space_key },
            body: {
              atlas_doc_format: {
                value: JSON.stringify(adf),
                representation: "atlas_doc_format",
              },
            },
          };
          if (p.parent_id !== undefined) {
            payload["ancestors"] = [{ id: p.parent_id }];
          }
          const result = await ctx.sdk.createPage(payload);
          throwIfHttpError(result);
          return {
            id: result.data.id,
            title: result.data.title ?? p.title,
            version: result.data.version?.number ?? 1,
          };
        },
      },
      update_page: {
        description: "Update an existing Confluence page",
        params: updatePageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof updatePageParams>, ctx) => {
          const adf = toAdf(p.body);
          const payload = {
            type: "page",
            title: p.title,
            body: {
              atlas_doc_format: {
                value: JSON.stringify(adf),
                representation: "atlas_doc_format",
              },
            },
            version: { number: p.expected_version + 1 },
          };
          const result = await ctx.sdk.updatePage(p.page_id, payload);
          throwIfHttpError(result);
          return {
            id: p.page_id,
            version: result.data.version?.number ?? p.expected_version + 1,
            updated: true,
          };
        },
      },
      delete_page: {
        description: "Delete a Confluence page",
        params: deletePageParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof deletePageParams>, ctx) => {
          const result = await ctx.sdk.deletePage(p.page_id);
          throwIfHttpError(result);
          return { id: p.page_id, deleted: true };
        },
      },
      add_comment: {
        description: "Add a comment to a Confluence page",
        params: addCommentParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof addCommentParams>, ctx) => {
          const adf = toAdf(p.body);
          const payload = {
            type: "comment",
            container: { id: p.page_id, type: "page" },
            body: {
              atlas_doc_format: {
                value: JSON.stringify(adf),
                representation: "atlas_doc_format",
              },
            },
          };
          const result = await ctx.sdk.addComment(payload);
          throwIfHttpError(result);
          const r = result.data;
          return {
            comment_id: r.id,
            created: r.history?.createdDate ?? null,
            author: r.history?.createdBy?.displayName ?? null,
          };
        },
      },
      post_attachment: {
        description: "Upload one or more files as attachments to a Confluence page",
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
                throw new ConnectorError(
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
          const result = await ctx.sdk.postAttachment(p.page_id, files);
          throwIfHttpError(result);
          const attachments = Array.isArray(result.data.results)
            ? result.data.results
            : [];
          return {
            page_id: p.page_id,
            attachments: attachments.map((a) => ({
              id: a.id,
              title: a.title ?? "",
              mediaType: a.metadata?.mediaType ?? "application/octet-stream",
              size: a.extensions?.fileSize ?? 0,
            })),
          };
        },
      },
    },
    mapError: mapHttpError(CODE_MAP),
  });
}

// Default production connector — most consumers import from here.
const connector = buildConfluenceConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for advanced consumers.
export {
  ConfluenceClient,
  loadConfluenceCredentials,
  type ConfluenceClientOptions,
  type ConfluenceResult,
} from "./lib/confluence_client.js";
export { ConnectorError as ConfluenceError } from "narai-primitives/toolkit";
