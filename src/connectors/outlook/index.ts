/**
 * narai-primitives/outlook — Microsoft Outlook (Microsoft Graph mail) connector.
 *
 * Exposes 10 actions across the basic email surface: list/get/search messages,
 * list folders, list/get attachments (with toolkit-driven text extraction),
 * send mail, reply, move, and soft-delete (move-to-Deleted-Items). Writes
 * escalate by default; the `delete` aspect is floored (cannot be downgraded
 * to `success`).
 *
 * Auth: delegated OAuth via `@azure/msal-node` using a long-lived refresh
 * token. Reuses the `MS_*` environment variables already established by the
 * `teams` connector — operators with both can wire a single Entra app with
 * Mail.* scopes added.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ConnectorError,
  createConnector,
  extractBinary,
  FORMAT_MAP,
  sanitizeLabel,
  throwIfHttpError,
  type Connector,
} from "narai-primitives/toolkit";
import { z } from "zod";
import {
  OutlookClient,
  type GraphMessage,
  type GraphMessageAttachment,
  type GraphRecipient,
} from "./lib/outlook_client.js";
import {
  M365Auth as OutlookAuth,
  loadM365Credentials as loadOutlookCredentials,
} from "../_m365/auth.js";
import { makeM365MapError } from "../_m365/error.js";
import { markdownToHtml } from "../_m365/markdown_to_html.js";

// ── Param schemas ────────────────────────────────────────────────────────────

const LIST_DEFAULT = 25;
const LIST_CAP = 250;
const SEARCH_DEFAULT = 25;
const SEARCH_CAP = 100;

const messageId = z.string().min(1, "message_id is required");
const attachmentId = z.string().min(1, "attachment_id is required");

const contentInput = z.union([
  z.object({ format: z.literal("plain"), value: z.string() }),
  z.object({ format: z.literal("markdown"), value: z.string() }),
  z.object({ format: z.literal("html"), value: z.string() }),
]);

const recipient = z.union([
  z.string().email(),
  z.object({
    address: z.string().email(),
    name: z.string().optional(),
  }),
]);

const listMessagesParams = z.object({
  folder_id: z.string().min(1).default("inbox"),
  max_results: z.coerce.number().int().positive().default(LIST_DEFAULT),
});

const getMessageParams = z.object({
  message_id: messageId,
  expand_attachments: z.boolean().default(false),
});

const searchMessagesParams = z.object({
  query: z.string().min(1, "search requires a non-empty 'query' string"),
  max_results: z.coerce.number().int().positive().default(SEARCH_DEFAULT),
});

const listFoldersParams = z.object({
  max_results: z.coerce.number().int().positive().default(LIST_DEFAULT),
});

const listAttachmentsParams = z.object({
  message_id: messageId,
});

const getAttachmentParams = z.object({
  message_id: messageId,
  attachment_id: attachmentId,
});

const sendMessageParams = z.object({
  to: z.array(recipient).min(1, "at least one 'to' recipient is required"),
  cc: z.array(recipient).optional(),
  bcc: z.array(recipient).optional(),
  subject: z.string(),
  body: contentInput,
  save_to_sent_items: z.boolean().default(true),
});

const replyToMessageParams = z
  .object({
    message_id: messageId,
    comment: z.string().optional(),
    body: contentInput.optional(),
  })
  // Microsoft Graph's POST /me/messages/{id}/reply rejects requests that
  // include BOTH `comment` and `message.body` with HTTP 400. Enforce XOR
  // here so callers get a clear validation error instead of a 400 from
  // Graph at request time.
  .refine(
    (v) => (v.comment !== undefined) !== (v.body !== undefined),
    {
      message:
        "reply_to_message requires exactly one of 'comment' or 'body' (not both, not neither)",
      path: ["comment"],
    },
  );

const deleteMessageParams = z.object({
  message_id: messageId,
});

const moveMessageParams = z.object({
  message_id: messageId,
  destination_folder_id: z
    .string()
    .min(1, "destination_folder_id is required"),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type RecipientInput = z.infer<typeof recipient>;
type ContentInput = z.infer<typeof contentInput>;

function toGraphRecipient(input: RecipientInput): GraphRecipient {
  if (typeof input === "string") {
    return { emailAddress: { address: input } };
  }
  const ea: { address: string; name?: string } = { address: input.address };
  if (input.name !== undefined) ea.name = input.name;
  return { emailAddress: ea };
}

function toGraphBody(input: ContentInput): { contentType: "Text" | "HTML"; content: string } {
  switch (input.format) {
    case "plain":
      return { contentType: "Text", content: input.value };
    case "markdown":
      return { contentType: "HTML", content: markdownToHtml(input.value) };
    case "html":
      return { contentType: "HTML", content: input.value };
  }
}

function summarizeMessage(m: GraphMessage): Record<string, unknown> {
  return {
    id: m.id,
    subject: m.subject ?? null,
    from: m.from?.emailAddress?.address ?? null,
    from_name: m.from?.emailAddress?.name ?? null,
    to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? null),
    cc: (m.ccRecipients ?? []).map((r) => r.emailAddress?.address ?? null),
    received: m.receivedDateTime ?? null,
    sent: m.sentDateTime ?? null,
    is_read: m.isRead ?? null,
    is_draft: m.isDraft ?? null,
    has_attachments: m.hasAttachments ?? false,
    conversation_id: m.conversationId ?? null,
    parent_folder_id: m.parentFolderId ?? null,
    web_link: m.webLink ?? null,
    body_preview: m.bodyPreview ?? null,
  };
}

function fullMessage(m: GraphMessage): Record<string, unknown> {
  const base = summarizeMessage(m);
  return {
    ...base,
    importance: m.importance ?? null,
    created: m.createdDateTime ?? null,
    last_modified: m.lastModifiedDateTime ?? null,
    bcc: (m.bccRecipients ?? []).map((r) => r.emailAddress?.address ?? null),
    body: m.body ?? null,
    attachments: m.attachments?.map((a) => ({
      id: a.id,
      name: a.name ?? null,
      content_type: a.contentType ?? null,
      size: a.size ?? null,
      is_inline: a.isInline ?? false,
      odata_type: a["@odata.type"] ?? null,
    })),
  };
}

const FILE_ATTACHMENT_TYPE = "#microsoft.graph.fileAttachment";

function attachmentKind(att: GraphMessageAttachment): string {
  const t = att["@odata.type"] ?? "";
  return t || "unknown";
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<OutlookClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

export function outlookScope(ctx: {
  sdk: OutlookClient;
  action: string;
  params: unknown;
}): string | null {
  return ctx.sdk.tenantId || null;
}

export function buildOutlookConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadOutlookCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<OutlookClient> => {
    const creds = await loadOutlookCredentials();
    if (!creds) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        "Outlook credentials not configured. Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REFRESH_TOKEN, or register a credential provider via narai-primitives/credentials.",
        false,
      );
    }
    const auth = new OutlookAuth(creds);
    return new OutlookClient({ auth });
  };

  return createConnector<OutlookClient>({
    name: "outlook",
    version: "1.0.0",
    scope: outlookScope,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    policyFloorAspects: ["delete"],
    defaultPolicy: {
      read: "success",
      write: "escalate",
      admin: "denied",
      aspects: { delete: "escalate" },
    },
    actions: {
      // ── Reads ────────────────────────────────────────────────────────────
      list_messages: {
        description:
          "List recent messages in a mail folder (default 'inbox'), newest first.",
        params: listMessagesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listMessagesParams>, ctx) => {
          const max = Math.min(p.max_results, LIST_CAP);
          const result = await ctx.sdk.listMessages(p.folder_id, max);
          throwIfHttpError(result);
          return {
            folder_id: p.folder_id,
            total: result.data.items.length,
            truncated: result.data.truncated,
            messages: result.data.items.map(summarizeMessage),
          };
        },
      },

      get_message: {
        description:
          "Fetch a single message by id; optionally expand attachment metadata.",
        params: getMessageParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getMessageParams>, ctx) => {
          const expand = p.expand_attachments ? ["attachments"] : undefined;
          const result = await ctx.sdk.getMessage(p.message_id, expand);
          throwIfHttpError(result);
          return fullMessage(result.data);
        },
      },

      search_messages: {
        description:
          "Search mailbox messages by free-text query via Microsoft Search.",
        params: searchMessagesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof searchMessagesParams>, ctx) => {
          const limit = Math.min(p.max_results, SEARCH_CAP);
          const result = await ctx.sdk.searchMessages(p.query, limit);
          throwIfHttpError(result);
          const containers = result.data.value?.[0]?.hitsContainers ?? [];
          const hits = containers.flatMap((c) => c.hits ?? []);
          const moreAvailable = containers.some(
            (c) => c.moreResultsAvailable === true,
          );
          return {
            query: p.query,
            total: hits.length,
            truncated: moreAvailable,
            results: hits.map((h) => ({
              hit_id: h.hitId,
              rank: h.rank ?? null,
              summary: h.summary ?? null,
              message_id: h.resource?.id ?? null,
              subject: h.resource?.subject ?? null,
              from: h.resource?.from?.emailAddress?.address ?? null,
              received: h.resource?.receivedDateTime ?? null,
              web_link: h.resource?.webLink ?? null,
            })),
          };
        },
      },

      list_folders: {
        description: "List mail folders for the signed-in user's mailbox.",
        params: listFoldersParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listFoldersParams>, ctx) => {
          const max = Math.min(p.max_results, LIST_CAP);
          const result = await ctx.sdk.listFolders(max);
          throwIfHttpError(result);
          return {
            total: result.data.items.length,
            truncated: result.data.truncated,
            folders: result.data.items.map((f) => ({
              id: f.id,
              display_name: f.displayName ?? null,
              parent_folder_id: f.parentFolderId ?? null,
              child_folder_count: f.childFolderCount ?? 0,
              unread_item_count: f.unreadItemCount ?? 0,
              total_item_count: f.totalItemCount ?? 0,
              well_known_name: f.wellKnownName ?? null,
            })),
          };
        },
      },

      list_attachments: {
        description: "List attachment metadata for a message.",
        params: listAttachmentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listAttachmentsParams>, ctx) => {
          const result = await ctx.sdk.listAttachments(p.message_id);
          throwIfHttpError(result);
          const items = result.data.value ?? [];
          return {
            message_id: p.message_id,
            total: items.length,
            attachments: items.map((a) => ({
              id: a.id,
              name: a.name ?? null,
              content_type: a.contentType ?? null,
              size: a.size ?? null,
              is_inline: a.isInline ?? false,
              kind: attachmentKind(a),
            })),
          };
        },
      },

      get_attachment: {
        description:
          "Download a file attachment and extract its text (pdf/docx/pptx/text). For non-file attachments returns metadata only.",
        params: getAttachmentParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getAttachmentParams>, ctx) => {
          // Pull metadata first so we can branch on attachment kind.
          const metaRes = await ctx.sdk.listAttachmentMetadata(
            p.message_id,
            p.attachment_id,
          );
          throwIfHttpError(metaRes);
          const meta = metaRes.data;
          const kind = attachmentKind(meta);

          // Non-file attachments (itemAttachment, referenceAttachment): no bytes.
          if (kind !== FILE_ATTACHMENT_TYPE) {
            return {
              attachment_id: meta.id,
              message_id: p.message_id,
              filename: sanitizeLabel(meta.name ?? "attachment", 255),
              media_type: meta.contentType ?? null,
              size_bytes: meta.size ?? null,
              kind,
              extracted: {
                format: "skipped" as const,
                text: null,
                warning: "non-file attachment",
              },
            };
          }

          // File attachment — fetch raw bytes via $value, then extract.
          const dl = await ctx.sdk.getAttachmentValue(
            p.message_id,
            p.attachment_id,
          );
          throwIfHttpError(dl);
          const { bytes } = dl.data;
          const contentType = meta.contentType ?? dl.data.contentType;
          const filename = meta.name ?? dl.data.filename;
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
              `outlook-attach-${randomUUID()}${ext}`,
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
            attachment_id: meta.id,
            message_id: p.message_id,
            filename: sanitizeLabel(filename, 255),
            media_type: contentType,
            size_bytes: bytes.byteLength,
            checksum,
            kind,
            extracted,
          };
        },
      },

      // ── Writes ───────────────────────────────────────────────────────────
      send_message: {
        description:
          "Send a new email on behalf of the signed-in user via /me/sendMail.",
        params: sendMessageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof sendMessageParams>, ctx) => {
          const message: Record<string, unknown> = {
            subject: p.subject,
            body: toGraphBody(p.body),
            toRecipients: p.to.map(toGraphRecipient),
          };
          if (p.cc && p.cc.length > 0)
            message["ccRecipients"] = p.cc.map(toGraphRecipient);
          if (p.bcc && p.bcc.length > 0)
            message["bccRecipients"] = p.bcc.map(toGraphRecipient);
          const payload: Record<string, unknown> = {
            message,
            saveToSentItems: p.save_to_sent_items,
          };
          const result = await ctx.sdk.sendMail(payload);
          throwIfHttpError(result);
          return {
            accepted: true,
            status: result.status,
            recipients: {
              to: p.to.length,
              cc: p.cc?.length ?? 0,
              bcc: p.bcc?.length ?? 0,
            },
          };
        },
      },

      reply_to_message: {
        description:
          "Reply to a message — supply 'comment' (simple text) or 'body' (rich content) or both.",
        params: replyToMessageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof replyToMessageParams>, ctx) => {
          const payload: Record<string, unknown> = {};
          if (p.comment !== undefined) payload["comment"] = p.comment;
          if (p.body !== undefined) {
            payload["message"] = { body: toGraphBody(p.body) };
          }
          const result = await ctx.sdk.replyToMessage(p.message_id, payload);
          throwIfHttpError(result);
          return {
            accepted: true,
            status: result.status,
            message_id: p.message_id,
          };
        },
      },

      delete_message: {
        description:
          "Soft-delete a message by moving it to the 'Deleted Items' folder (standard Outlook delete UX).",
        params: deleteMessageParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof deleteMessageParams>, ctx) => {
          const result = await ctx.sdk.moveMessage(p.message_id, "deleteditems");
          throwIfHttpError(result);
          return {
            message_id: result.data.id,
            moved_to: "deleteditems",
            parent_folder_id: result.data.parentFolderId ?? null,
            deleted: true,
          };
        },
      },

      move_message: {
        description:
          "Move a message to another folder. Accepts a well-known name (inbox, archive, sentitems, ...) or a folder id.",
        params: moveMessageParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof moveMessageParams>, ctx) => {
          const result = await ctx.sdk.moveMessage(
            p.message_id,
            p.destination_folder_id,
          );
          throwIfHttpError(result);
          return {
            message_id: result.data.id,
            destination_folder_id: p.destination_folder_id,
            parent_folder_id: result.data.parentFolderId ?? null,
            moved: true,
          };
        },
      },
    },
    mapError: makeM365MapError(),
  });
}

// Default production connector instance
const connector = buildOutlookConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for callers / tests
export {
  OutlookClient,
  type OutlookClientOptions,
  type OutlookResult,
} from "./lib/outlook_client.js";
export {
  M365Auth as OutlookAuth,
  loadM365Credentials as loadOutlookCredentials,
  type M365Credentials as OutlookCredentials,
} from "../_m365/auth.js";
export { M365Error as OutlookError } from "../_m365/error.js";
