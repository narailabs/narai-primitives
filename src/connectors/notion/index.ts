/**
 * @narai/notion-agent-connector — read-only Notion connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector` instance; `buildNotionConnector(overrides?)` is exposed
 * for tests that want to inject a fake Notion client.
 */
import {
  createConnector,
  fetchAttachment,
  sanitizeLabel,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { z } from "zod";
import {
  NotionClient,
  extractTitleFromPage,
  loadNotionCredentials,
  type NotionResult,
  type NotionRawBlock,
} from "./lib/notion_client.js";
import { NotionError } from "./lib/notion_error.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const MAX_RESULTS_DEFAULT = 25;
const MAX_RESULTS_CAP = 100;

const UUID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/;

const uuidField = (fieldName: string) =>
  z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(
      z
        .string()
        .regex(UUID_RE, `Invalid ${fieldName} — expected UUID format`),
    );

const searchParams = z.object({
  query: z.string().min(1, "search requires a non-empty 'query' string"),
  filter_type: z
    .union([z.literal("page"), z.literal("database"), z.literal("")])
    .default(""),
  max_results: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_RESULTS_DEFAULT),
});

const getPageParams = z.object({
  page_id: uuidField("page_id"),
});

const getDatabaseParams = z.object({
  database_id: uuidField("database_id"),
});

const queryDatabaseParams = z.object({
  database_id: uuidField("database_id"),
  filter: z.record(z.unknown()).nullable().default(null),
  max_results: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_RESULTS_DEFAULT),
});

const listAttachmentsParams = z.object({
  page_id: uuidField("page_id"),
});

const getAttachmentParams = z.object({
  page_id: uuidField("page_id"),
  block_id: uuidField("block_id"),
});

const getCommentsParams = z.object({
  page_id: uuidField("page_id"),
});

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation: Notion client codes → toolkit canonical codes
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
  HTTP_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
};

function throwIfError<T>(
  result: NotionResult<T>,
): asserts result is Extract<NotionResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new NotionError(
      result.code,
      result.message,
      result.retriable,
      result.status,
    );
  }
}

const FILE_BLOCK_TYPES = new Set([
  "file",
  "image",
  "pdf",
  "audio",
  "video",
]);

function normalizeFileBlockForFetch(
  block: NotionRawBlock,
): { type: string; url: string; filename: string | null } | null {
  if (typeof block.type !== "string" || !FILE_BLOCK_TYPES.has(block.type)) {
    return null;
  }
  const payload = block[block.type];
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const sub = p["type"];
  let url = "";
  if (sub === "file") {
    const f = p["file"];
    if (f && typeof f === "object") {
      const u = (f as Record<string, unknown>)["url"];
      if (typeof u === "string") url = u;
    }
  } else if (sub === "external") {
    const e = p["external"];
    if (e && typeof e === "object") {
      const u = (e as Record<string, unknown>)["url"];
      if (typeof u === "string") url = u;
    }
  }
  if (!url) return null;
  const filename =
    typeof p["name"] === "string" ? (p["name"] as string) : null;
  return { type: block.type, url, filename };
}

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<NotionClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

export function buildNotionConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadNotionCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<NotionClient> => {
    const creds = await loadNotionCredentials();
    if (!creds) {
      throw new NotionError(
        "CONFIG_ERROR",
        "Notion credentials not configured. Set NOTION_TOKEN or register a " +
          "credential provider via @narai/credential-providers.",
        false,
      );
    }
    const client = new NotionClient(creds);
    await client.init();
    return client;
  };

  return createConnector<NotionClient>({
    name: "notion",
    version: "3.0.1",
    scope: (ctx) => ctx.sdk.workspaceId,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    actions: {
      search: {
        description: "Search Notion for pages or databases by text query",
        params: searchParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof searchParams>, ctx) => {
          const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
          const filterType = p.filter_type === "" ? undefined : p.filter_type;
          const result = await ctx.sdk.search(p.query, filterType, limit);
          throwIfError(result);
          const results = Array.isArray(result.data.results)
            ? result.data.results
            : [];
          return {
            total: results.length,
            results: results.map((r) => ({
              id: r.id,
              object_type:
                "last_edited_time" in r && "properties" in r
                  ? "page"
                  : "database",
            })),
            truncated: Boolean(result.data.has_more),
          };
        },
      },
      get_page: {
        description: "Fetch a Notion page by UUID",
        params: getPageParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getPageParams>, ctx) => {
          const result = await ctx.sdk.getPage(p.page_id);
          throwIfError(result);
          const page = result.data;
          return {
            id: page.id,
            title: extractTitleFromPage(page),
            parent_type: page.parent?.type ?? "",
            last_edited: page.last_edited_time ?? null,
            properties: page.properties ?? {},
            content_markdown: "",
          };
        },
      },
      get_database: {
        description: "Fetch a Notion database schema by UUID",
        params: getDatabaseParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getDatabaseParams>, ctx) => {
          const result = await ctx.sdk.getDatabase(p.database_id);
          throwIfError(result);
          const db = result.data;
          return {
            id: db.id,
            title: (db.title ?? []).map((t) => t.plain_text ?? "").join(""),
            description: (db.description ?? [])
              .map((t) => t.plain_text ?? "")
              .join(""),
            properties: db.properties ?? {},
            is_inline: db.is_inline ?? false,
          };
        },
      },
      query_database: {
        description: "Query a Notion database with optional filter",
        params: queryDatabaseParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof queryDatabaseParams>, ctx) => {
          const limit = Math.min(p.max_results, MAX_RESULTS_CAP);
          const result = await ctx.sdk.queryDatabase(
            p.database_id,
            p.filter,
            limit,
          );
          throwIfError(result);
          const results = Array.isArray(result.data.results)
            ? result.data.results
            : [];
          return {
            database_id: p.database_id,
            total: results.length,
            results: results.map((r) => ({
              id: r.id,
              title: extractTitleFromPage(r),
              last_edited: r.last_edited_time ?? null,
            })),
            truncated: Boolean(result.data.has_more),
          };
        },
      },
      list_attachments: {
        description: "List file/image/pdf/audio/video blocks on a Notion page",
        params: listAttachmentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listAttachmentsParams>, ctx) => {
          const result = await ctx.sdk.listPageFileBlocks(p.page_id);
          throwIfError(result);
          const results = result.data.results ?? [];
          return {
            page_id: p.page_id,
            total: results.length,
            attachments: results.map((b) => ({
              attachment_id: b.id,
              block_type: b.type,
              url_type: b.url_type,
              expiry_time: b.expiry_time,
              caption: b.caption,
              filename: b.filename ?? null,
            })),
            truncated: result.data.has_more,
          };
        },
      },
      get_attachment: {
        description:
          "Download and extract a Notion file/image/pdf/audio/video block",
        params: getAttachmentParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getAttachmentParams>, ctx) => {
          const blockRes = await ctx.sdk.getBlock(p.block_id);
          throwIfError(blockRes);
          const normalized = normalizeFileBlockForFetch(blockRes.data);
          if (!normalized) {
            throw new NotionError(
              "BAD_REQUEST",
              `Block ${p.block_id} is not a downloadable file/image/pdf/audio/video block`,
              false,
              400,
            );
          }
          const attachment = await fetchAttachment(normalized.url);
          return {
            attachment_id: p.block_id,
            page_id: p.page_id,
            block_type: normalized.type,
            filename: sanitizeLabel(
              normalized.filename ?? attachment.filename,
              255,
            ),
            media_type: attachment.contentType,
            size_bytes: attachment.sizeBytes,
            checksum: attachment.checksum,
            extracted: attachment.extracted,
            source_url: attachment.sourceUrl,
          };
        },
      },
      get_comments: {
        description: "List page-level comments on a Notion page",
        params: getCommentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getCommentsParams>, ctx) => {
          const result = await ctx.sdk.getComments(p.page_id);
          throwIfError(result);
          const results = result.data.results ?? [];
          return {
            page_id: p.page_id,
            total: results.length,
            comments: results.map((c) => ({
              comment_id: c.id,
              author_id: c.author_id,
              created: c.created,
              body_plain: c.body_plain,
              parent_page_id: c.parent_page_id,
            })),
            truncated: result.data.has_more,
          };
        },
      },
    },
    mapError: (err) => {
      if (err instanceof NotionError) {
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
const connector = buildNotionConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for advanced consumers.
export {
  NotionClient,
  extractTitleFromPage,
  loadNotionCredentials,
  type NotionClientOptions,
  type NotionResult,
} from "./lib/notion_client.js";
export { NotionError } from "./lib/notion_error.js";
