/**
 * @narai/confluence-agent-connector — read-only Confluence connector.
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
  extractBinary,
  FORMAT_MAP,
  sanitizeLabel,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { z } from "zod";
import {
  ConfluenceClient,
  loadConfluenceCredentials,
  type ConfluenceResult,
} from "./lib/confluence_client.js";
import { ConfluenceError } from "./lib/confluence_error.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const MAX_RESULTS_DEFAULT = 25;
const MAX_RESULTS_CAP = 500;

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
  space_key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9]{1,19}$/,
      "Invalid space_key — expected uppercase key like DEV",
    ),
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

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation: Confluence client codes → toolkit canonical codes
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

/** Throw a ConfluenceError for a failed client result; type-narrows to the ok branch. */
function throwIfError<T>(
  result: ConfluenceResult<T>,
): asserts result is Extract<ConfluenceResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new ConfluenceError(
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
  /** Inject a custom Confluence client (tests). */
  sdk?: () => Promise<ConfluenceClient>;
  /** Override credentials loader (tests). */
  credentials?: () => Promise<Record<string, unknown>>;
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
      throw new ConfluenceError(
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
    actions: {
      cql_search: {
        description: "Search Confluence pages with a CQL query",
        params: cqlSearchParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof cqlSearchParams>, ctx) => {
          const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
          const result = await ctx.sdk.searchCql(p.cql, limit);
          throwIfError(result);
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
          throwIfError(result);
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
          throwIfError(result);
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
          throwIfError(result);
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
          throwIfError(list);
          const match = (list.data.results ?? []).find(
            (a) => a.id === p.attachment_id,
          );
          if (!match) {
            throw new ConfluenceError(
              "NOT_FOUND",
              `Attachment ${p.attachment_id} not found on page ${p.page_id}`,
              false,
              404,
            );
          }
          const downloadPath = match._links?.download;
          if (!downloadPath) {
            throw new ConfluenceError(
              "BAD_REQUEST",
              `Attachment ${p.attachment_id} has no download link`,
              false,
            );
          }
          const dl = await ctx.sdk.getAttachmentDownload(downloadPath);
          throwIfError(dl);
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
          throwIfError(result);
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
    },
    mapError: (err) => {
      if (err instanceof ConfluenceError) {
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
export { ConfluenceError } from "./lib/confluence_error.js";
