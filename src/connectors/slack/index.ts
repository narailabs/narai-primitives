/**
 * @narai/slack-agent-connector — read + write Slack connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector` instance; `buildSlackConnector(overrides?)` is exposed for
 * tests that want to inject a fake Slack client.
 *
 * Slack specifics:
 *  - Every Web API response is HTTP 200 with `{ok, error?, ...}`. The
 *    client translates `ok=false` into a `HttpResultErr` whose `code` is
 *    the uppercased Slack error string (e.g. `CHANNEL_NOT_FOUND`).
 *  - `search.messages` / `search.files` require a user token. The client
 *    throws `CONFIG_ERROR` from inside the handler if it's not set.
 *  - File uploads use the 2-step `files.getUploadURLExternal` +
 *    `files.completeUploadExternal` flow with a raw POST in between.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ConnectorError,
  checkPathContainment,
  createConnector,
  fetchAttachment,
  mapHttpError,
  sanitizeLabel,
  throwIfHttpError,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { z } from "zod";
import {
  SlackClient,
  loadSlackCredentials,
} from "./lib/slack_client.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const channelIdSchema = z.string().min(1, "channel_id is required");
const userIdSchema = z.string().min(1, "user_id is required");
const tsSchema = z.string().min(1, "ts is required");

const listChannelsParams = z.object({
  types: z.string().default("public_channel,private_channel"),
  max_results: z.coerce.number().int().positive().default(100),
});

const getChannelParams = z.object({
  channel_id: channelIdSchema,
});

const getChannelHistoryParams = z.object({
  channel_id: channelIdSchema,
  max_results: z.coerce.number().int().positive().default(100),
  oldest: z.string().optional(),
  latest: z.string().optional(),
});

const getThreadRepliesParams = z.object({
  channel_id: channelIdSchema,
  thread_ts: tsSchema,
  max_results: z.coerce.number().int().positive().default(100),
});

const listUsersParams = z.object({
  max_results: z.coerce.number().int().positive().default(200),
});

const getUserParams = z
  .object({
    user_id: z.string().optional(),
    email: z.string().email().optional(),
  })
  .refine(
    (p) => (p.user_id !== undefined) !== (p.email !== undefined),
    "Exactly one of user_id or email is required",
  );

const listFilesParams = z.object({
  channel_id: channelIdSchema.optional(),
  user_id: userIdSchema.optional(),
  max_results: z.coerce.number().int().positive().default(100),
});

const getFileParams = z.object({
  file_id: z.string().min(1, "file_id is required"),
});

const searchMessagesParams = z.object({
  query: z.string().min(1, "search requires a non-empty 'query' string"),
  max_results: z.coerce.number().int().positive().default(20),
});

const searchFilesParams = z.object({
  query: z.string().min(1, "search requires a non-empty 'query' string"),
  max_results: z.coerce.number().int().positive().default(20),
});

// ── Content input (shared by write actions) ─────────────────────────────

const contentInput = z.union([
  z.object({ format: z.literal("plain"), value: z.string() }),
  z.object({ format: z.literal("markdown"), value: z.string() }),
  z.object({ format: z.literal("blocks"), value: z.array(z.unknown()) }),
]);

type ContentInput = z.infer<typeof contentInput>;

/**
 * Resolve a ContentInput into the Slack message fields. `plain`/`markdown`
 * map to `text` (Slack mrkdwn is markdown-flavored, no transformation
 * needed); `blocks` map to `blocks` plus a brief `text` fallback that
 * Slack uses for notifications and accessibility.
 */
function resolveContent(input: ContentInput): {
  text?: string;
  blocks?: unknown[];
} {
  if (input.format === "blocks") {
    return { text: "(rich content)", blocks: input.value };
  }
  return { text: input.value };
}

const postMessageParams = z.object({
  channel_id: channelIdSchema,
  body: contentInput,
});

const updateMessageParams = z.object({
  channel_id: channelIdSchema,
  ts: tsSchema,
  body: contentInput,
});

const postThreadReplyParams = z.object({
  channel_id: channelIdSchema,
  thread_ts: tsSchema,
  body: contentInput,
});

const deleteMessageParams = z.object({
  channel_id: channelIdSchema,
  ts: tsSchema,
});

const reactionNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_+\-:]+$/, "Invalid reaction name");

const addReactionParams = z.object({
  channel_id: channelIdSchema,
  ts: tsSchema,
  name: reactionNameSchema,
});

const removeReactionParams = z.object({
  channel_id: channelIdSchema,
  ts: tsSchema,
  name: reactionNameSchema,
});

const uploadFileParams = z
  .object({
    channel_id: channelIdSchema.optional(),
    filename: z.string().min(1, "filename is required"),
    content_base64: z.string().optional(),
    path: z.string().optional(),
    mime_type: z.string().optional(),
    alt_text: z.string().optional(),
  })
  .refine(
    (p) => (p.content_base64 !== undefined) !== (p.path !== undefined),
    "Exactly one of content_base64 or path is required",
  );

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation: Slack codes (and HTTP-shape codes) → toolkit codes
// ───────────────────────────────────────────────────────────────────────────

const CODE_MAP: Record<string, ErrorCode> = {
  // HTTP-shape codes from the toolkit HttpClient itself.
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
  VALIDATION_ERROR: "VALIDATION_ERROR",
  // Slack-specific body.error strings (uppercased by the client).
  INVALID_AUTH: "AUTH_ERROR",
  NOT_AUTHED: "AUTH_ERROR",
  TOKEN_REVOKED: "AUTH_ERROR",
  TOKEN_EXPIRED: "AUTH_ERROR",
  ACCOUNT_INACTIVE: "AUTH_ERROR",
  MISSING_SCOPE: "AUTH_ERROR",
  NOT_ALLOWED_TOKEN_TYPE: "AUTH_ERROR",
  CHANNEL_NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "NOT_FOUND",
  MESSAGE_NOT_FOUND: "NOT_FOUND",
  FILE_NOT_FOUND: "NOT_FOUND",
  NOT_IN_CHANNEL: "NOT_FOUND",
  RATELIMITED: "RATE_LIMITED",
  INVALID_ARGUMENTS: "VALIDATION_ERROR",
  INVALID_ARGUMENT_NAME: "VALIDATION_ERROR",
  INVALID_BLOCKS: "VALIDATION_ERROR",
  INVALID_BLOCKS_FORMAT: "VALIDATION_ERROR",
  MSG_TOO_LONG: "VALIDATION_ERROR",
  NO_TEXT: "VALIDATION_ERROR",
  FATAL_ERROR: "CONNECTION_ERROR",
  INTERNAL_ERROR: "CONNECTION_ERROR",
  SERVICE_UNAVAILABLE: "CONNECTION_ERROR",
  REQUEST_TIMEOUT: "CONNECTION_ERROR",
  SLACK_ERROR: "CONNECTION_ERROR",
};

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<SlackClient>;
  credentials?: () => Promise<Record<string, unknown>>;
  /** Override the default policy rules (used in tests). */
  defaultPolicy?: import("narai-primitives/toolkit").PolicyRules;
}

export function buildSlackConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadSlackCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<SlackClient> => {
    const creds = await loadSlackCredentials();
    if (!creds) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        "Slack credentials not configured. Set SLACK_BOT_TOKEN (and " +
          "optionally SLACK_USER_TOKEN, SLACK_DEFAULT_TEAM_ID) or register " +
          "a credential provider via narai-primitives/credentials.",
        false,
      );
    }
    return new SlackClient(creds);
  };

  return createConnector<SlackClient>({
    name: "slack",
    version: "1.0.0",
    scope: (ctx) => ctx.sdk.defaultTeamId,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    policyFloorAspects: ["delete"],
    defaultPolicy: overrides.defaultPolicy ?? {
      read: "success",
      write: "escalate",
      admin: "denied",
      aspects: { delete: "escalate" },
    },
    actions: {
      // ── Read actions ────────────────────────────────────────────────────

      list_channels: {
        description: "List Slack channels the bot can see",
        params: listChannelsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listChannelsParams>, ctx) => {
          const limit = Math.min(p.max_results, 1000);
          const result = await ctx.sdk.listChannels(p.types, limit);
          throwIfHttpError(result);
          const channels = result.data.channels ?? [];
          return {
            total: channels.length,
            channels: channels.map((c) => ({
              id: c.id,
              name: c.name ?? null,
              is_private: c.is_private ?? false,
              is_archived: c.is_archived ?? false,
              is_member: c.is_member ?? false,
              num_members: c.num_members ?? null,
              topic: c.topic?.value ?? "",
              purpose: c.purpose?.value ?? "",
            })),
            truncated: Boolean(result.data.response_metadata?.next_cursor),
          };
        },
      },

      get_channel: {
        description: "Fetch metadata for a single Slack channel",
        params: getChannelParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getChannelParams>, ctx) => {
          const result = await ctx.sdk.getChannel(p.channel_id);
          throwIfHttpError(result);
          const ch = result.data.channel;
          if (!ch) {
            throw new ConnectorError(
              "NOT_FOUND",
              `Channel '${p.channel_id}' not found`,
              false,
              404,
            );
          }
          return {
            id: ch.id,
            name: ch.name ?? null,
            is_private: ch.is_private ?? false,
            is_archived: ch.is_archived ?? false,
            is_member: ch.is_member ?? false,
            num_members: ch.num_members ?? null,
            topic: ch.topic?.value ?? "",
            purpose: ch.purpose?.value ?? "",
          };
        },
      },

      get_channel_history: {
        description: "Fetch the most recent messages in a Slack channel",
        params: getChannelHistoryParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getChannelHistoryParams>, ctx) => {
          const limit = Math.min(p.max_results, 1000);
          const result = await ctx.sdk.getChannelHistory(
            p.channel_id,
            limit,
            p.oldest,
            p.latest,
          );
          throwIfHttpError(result);
          const messages = result.data.messages ?? [];
          return {
            channel_id: p.channel_id,
            total: messages.length,
            messages: messages.map((m) => ({
              ts: m.ts,
              thread_ts: m.thread_ts ?? null,
              user: m.user ?? null,
              bot_id: m.bot_id ?? null,
              text: m.text ?? "",
              reply_count: m.reply_count ?? 0,
              reaction_count: Array.isArray(m.reactions) ? m.reactions.length : 0,
              file_count: Array.isArray(m.files) ? m.files.length : 0,
            })),
            truncated: Boolean(result.data.has_more),
          };
        },
      },

      get_thread_replies: {
        description: "Fetch replies to a Slack thread by its parent ts",
        params: getThreadRepliesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getThreadRepliesParams>, ctx) => {
          const limit = Math.min(p.max_results, 1000);
          const result = await ctx.sdk.getThreadReplies(
            p.channel_id,
            p.thread_ts,
            limit,
          );
          throwIfHttpError(result);
          const messages = result.data.messages ?? [];
          return {
            channel_id: p.channel_id,
            thread_ts: p.thread_ts,
            total: messages.length,
            messages: messages.map((m) => ({
              ts: m.ts,
              user: m.user ?? null,
              bot_id: m.bot_id ?? null,
              text: m.text ?? "",
              reaction_count: Array.isArray(m.reactions) ? m.reactions.length : 0,
              file_count: Array.isArray(m.files) ? m.files.length : 0,
            })),
            truncated: Boolean(result.data.has_more),
          };
        },
      },

      list_users: {
        description: "List Slack workspace users",
        params: listUsersParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listUsersParams>, ctx) => {
          const limit = Math.min(p.max_results, 1000);
          const result = await ctx.sdk.listUsers(limit);
          throwIfHttpError(result);
          const members = result.data.members ?? [];
          return {
            total: members.length,
            users: members.map((u) => ({
              id: u.id,
              name: u.name ?? null,
              real_name: u.real_name ?? u.profile?.real_name ?? null,
              display_name: u.profile?.display_name ?? null,
              email: u.profile?.email ?? null,
              is_bot: u.is_bot ?? false,
              deleted: u.deleted ?? false,
            })),
            truncated: Boolean(result.data.response_metadata?.next_cursor),
          };
        },
      },

      get_user: {
        description: "Fetch a Slack user by id or email (exactly one required)",
        params: getUserParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getUserParams>, ctx) => {
          const result = p.user_id
            ? await ctx.sdk.getUserById(p.user_id)
            : await ctx.sdk.getUserByEmail(p.email!);
          throwIfHttpError(result);
          const u = result.data.user;
          if (!u) {
            const ident = p.user_id ?? p.email ?? "";
            throw new ConnectorError(
              "NOT_FOUND",
              `User '${ident}' not found`,
              false,
              404,
            );
          }
          return {
            id: u.id,
            name: u.name ?? null,
            real_name: u.real_name ?? u.profile?.real_name ?? null,
            display_name: u.profile?.display_name ?? null,
            email: u.profile?.email ?? null,
            is_bot: u.is_bot ?? false,
            deleted: u.deleted ?? false,
          };
        },
      },

      list_files: {
        description: "List files visible to the bot, optionally scoped to a channel or user",
        params: listFilesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listFilesParams>, ctx) => {
          const limit = Math.min(p.max_results, 1000);
          const result = await ctx.sdk.listFiles(
            p.channel_id,
            p.user_id,
            limit,
          );
          throwIfHttpError(result);
          const files = result.data.files ?? [];
          const paging = result.data.paging;
          return {
            total: paging?.total ?? files.length,
            files: files.map((f) => ({
              id: f.id,
              name: f.name ?? null,
              title: f.title ?? null,
              mime_type: f.mimetype ?? null,
              filetype: f.filetype ?? null,
              size_bytes: f.size ?? 0,
              user: f.user ?? null,
              created: f.created ?? null,
              permalink: f.permalink ?? null,
            })),
            truncated:
              paging !== undefined &&
              (paging.page ?? 1) < (paging.pages ?? 1),
          };
        },
      },

      get_file: {
        description: "Fetch a Slack file's metadata and download / extract its contents",
        params: getFileParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getFileParams>, ctx) => {
          const info = await ctx.sdk.getFileInfo(p.file_id);
          throwIfHttpError(info);
          const file = info.data.file;
          if (!file) {
            throw new ConnectorError(
              "NOT_FOUND",
              `File '${p.file_id}' not found`,
              false,
              404,
            );
          }
          const url = file.url_private_download ?? file.url_private ?? null;
          if (!url) {
            throw new ConnectorError(
              "BAD_REQUEST",
              `File '${p.file_id}' has no downloadable URL`,
              false,
              400,
            );
          }
          let attachment: Awaited<ReturnType<typeof fetchAttachment>>;
          try {
            attachment = await fetchAttachment(url, {
              headers: { Authorization: ctx.sdk.botAuthHeader },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isDeterministic =
              message.includes("invalid URL scheme") ||
              (err instanceof Error &&
                err.constructor?.name === "FetchCapExceeded");
            throw new ConnectorError(
              isDeterministic ? "BAD_REQUEST" : "HTTP_ERROR",
              `Failed to fetch Slack file URL: ${message}`,
              !isDeterministic,
            );
          }
          return {
            file_id: file.id,
            filename: sanitizeLabel(
              file.name ?? attachment.filename,
              255,
            ),
            title: file.title ?? null,
            media_type: attachment.contentType,
            size_bytes: attachment.sizeBytes,
            checksum: attachment.checksum,
            extracted: attachment.extracted,
            source_url: attachment.sourceUrl,
          };
        },
      },

      search_messages: {
        description: "Full-text search across Slack messages (user token required)",
        params: searchMessagesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof searchMessagesParams>, ctx) => {
          const limit = Math.min(p.max_results, 100);
          const result = await ctx.sdk.searchMessages(p.query, limit);
          throwIfHttpError(result);
          // Slack's search.messages nests matches under `messages.matches`,
          // not at the top level — distinct shape from list endpoints.
          const matches = result.data.messages?.matches ?? [];
          const total = result.data.messages?.total ?? matches.length;
          const pagination = result.data.messages?.pagination;
          return {
            total,
            results: matches.map((m) => ({
              ts: m.ts,
              user: m.user ?? null,
              text: m.text ?? "",
            })),
            truncated:
              pagination !== undefined &&
              (pagination.page ?? 1) < (pagination.page_count ?? 1),
          };
        },
      },

      search_files: {
        description: "Full-text search across Slack files (user token required)",
        params: searchFilesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof searchFilesParams>, ctx) => {
          const limit = Math.min(p.max_results, 100);
          const result = await ctx.sdk.searchFiles(p.query, limit);
          throwIfHttpError(result);
          // Slack's search.files nests matches under `files.matches`,
          // not at the top level — distinct shape from list endpoints.
          const matches = result.data.files?.matches ?? [];
          const total = result.data.files?.total ?? matches.length;
          const pagination = result.data.files?.pagination;
          return {
            total,
            results: matches.map((f) => ({
              id: f.id,
              name: f.name ?? null,
              title: f.title ?? null,
              mime_type: f.mimetype ?? null,
              permalink: f.permalink ?? null,
            })),
            truncated:
              pagination !== undefined &&
              (pagination.page ?? 1) < (pagination.page_count ?? 1),
          };
        },
      },

      // ── Write actions ───────────────────────────────────────────────────

      post_message: {
        description: "Post a new message to a Slack channel",
        params: postMessageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof postMessageParams>, ctx) => {
          const content = resolveContent(p.body);
          const payload: Record<string, unknown> = { channel: p.channel_id };
          if (content.text !== undefined) payload["text"] = content.text;
          if (content.blocks !== undefined) payload["blocks"] = content.blocks;
          const result = await ctx.sdk.postMessage(payload);
          throwIfHttpError(result);
          return {
            channel_id: result.data.channel ?? p.channel_id,
            ts: result.data.ts ?? "",
            posted: true,
          };
        },
      },

      update_message: {
        description: "Update an existing Slack message by ts",
        params: updateMessageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof updateMessageParams>, ctx) => {
          const content = resolveContent(p.body);
          const payload: Record<string, unknown> = {
            channel: p.channel_id,
            ts: p.ts,
          };
          if (content.text !== undefined) payload["text"] = content.text;
          if (content.blocks !== undefined) payload["blocks"] = content.blocks;
          const result = await ctx.sdk.updateMessage(payload);
          throwIfHttpError(result);
          return {
            channel_id: result.data.channel ?? p.channel_id,
            ts: result.data.ts ?? p.ts,
            updated: true,
          };
        },
      },

      post_thread_reply: {
        description: "Reply to an existing Slack thread",
        params: postThreadReplyParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof postThreadReplyParams>, ctx) => {
          const content = resolveContent(p.body);
          const payload: Record<string, unknown> = {
            channel: p.channel_id,
            thread_ts: p.thread_ts,
          };
          if (content.text !== undefined) payload["text"] = content.text;
          if (content.blocks !== undefined) payload["blocks"] = content.blocks;
          const result = await ctx.sdk.postMessage(payload);
          throwIfHttpError(result);
          return {
            channel_id: result.data.channel ?? p.channel_id,
            thread_ts: p.thread_ts,
            ts: result.data.ts ?? "",
            posted: true,
          };
        },
      },

      delete_message: {
        description: "Delete a Slack message by ts",
        params: deleteMessageParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof deleteMessageParams>, ctx) => {
          const result = await ctx.sdk.deleteMessage(p.channel_id, p.ts);
          throwIfHttpError(result);
          return {
            channel_id: p.channel_id,
            ts: p.ts,
            deleted: true,
          };
        },
      },

      add_reaction: {
        description: "Add an emoji reaction to a Slack message",
        params: addReactionParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof addReactionParams>, ctx) => {
          const result = await ctx.sdk.addReaction(p.channel_id, p.ts, p.name);
          throwIfHttpError(result);
          return {
            channel_id: p.channel_id,
            ts: p.ts,
            name: p.name,
            added: true,
          };
        },
      },

      remove_reaction: {
        description: "Remove an emoji reaction from a Slack message",
        params: removeReactionParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof removeReactionParams>, ctx) => {
          const result = await ctx.sdk.removeReaction(p.channel_id, p.ts, p.name);
          throwIfHttpError(result);
          return {
            channel_id: p.channel_id,
            ts: p.ts,
            name: p.name,
            removed: true,
          };
        },
      },

      upload_file: {
        description: "Upload a file to Slack and optionally share it in a channel",
        params: uploadFileParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof uploadFileParams>, ctx) => {
          let bytes: Uint8Array;
          if (p.content_base64 !== undefined) {
            bytes = new Uint8Array(Buffer.from(p.content_base64, "base64"));
          } else {
            // path: validate containment then read.
            if (!checkPathContainment(p.path!, process.cwd())) {
              throw new ConnectorError(
                "VALIDATION_ERROR",
                `Path '${p.path}' escapes working directory`,
                false,
                400,
              );
            }
            bytes = new Uint8Array(fs.readFileSync(p.path!));
          }
          const filename = p.filename || path.basename(p.path ?? "upload");
          const step1 = await ctx.sdk.getUploadUrlExternal(
            filename,
            bytes.byteLength,
            p.alt_text,
          );
          throwIfHttpError(step1);
          const uploadUrl = step1.data.upload_url;
          const fileId = step1.data.file_id;
          if (!uploadUrl || !fileId) {
            throw new ConnectorError(
              "CONNECTION_ERROR",
              "Slack files.getUploadURLExternal returned no upload_url or file_id",
              true,
            );
          }
          await ctx.sdk.uploadBytes(uploadUrl, bytes, p.mime_type);
          const step2 = await ctx.sdk.completeUploadExternal(
            fileId,
            filename,
            p.channel_id,
            undefined,
          );
          throwIfHttpError(step2);
          const completed = step2.data.files?.[0];
          return {
            file_id: completed?.id ?? fileId,
            filename,
            channel_id: p.channel_id ?? null,
            uploaded: true,
          };
        },
      },
    },
    mapError: (err) => {
      // ConnectorError is the only shape we need to translate — both the
      // toolkit-shaped HTTP errors (UNAUTHORIZED, RATE_LIMITED, …) and
      // the Slack-shaped body errors (CHANNEL_NOT_FOUND, …) arrive here
      // as ConnectorError thanks to the client's _call() translation.
      return mapHttpError(CODE_MAP)(err);
    },
  });
}

// Default production connector.
const connector = buildSlackConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for advanced consumers.
export {
  SlackClient,
  loadSlackCredentials,
  type SlackClientOptions,
  type SlackResult,
} from "./lib/slack_client.js";
export { ConnectorError as SlackError } from "narai-primitives/toolkit";
