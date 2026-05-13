/**
 * Attachments action specs.
 *
 *   - `get_attachment`     : read — locate the attachment on a channel or
 *                            chat message, follow the OneDrive `contentUrl`
 *                            via the toolkit's `fetchAttachment` helper for
 *                            size capping + text extraction.
 *   - `upload_attachment`  : write — upload bytes (base64 or filesystem path)
 *                            to OneDrive under `Apps/Teams Uploads/`, then
 *                            post a new message referencing the drive item.
 *                            If `path` is supplied, it is validated via the
 *                            toolkit's `checkPathContainment` against the
 *                            process cwd to prevent traversal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ConnectorError,
  fetchAttachment,
  checkPathContainment,
  sanitizeLabel,
  throwIfHttpError,
} from "narai-primitives/toolkit";
import { z } from "zod";
import type { TeamsActions } from "./_types.js";
import type { GraphMessage } from "../lib/teams_client.js";

const getAttachmentParams = z
  .object({
    team_id: z.string().min(1).optional(),
    channel_id: z.string().min(1).optional(),
    chat_id: z.string().min(1).optional(),
    message_id: z.string().min(1, "message_id required"),
    attachment_id: z.string().min(1, "attachment_id required"),
  })
  .refine(
    (v) => {
      const isChannel = Boolean(v.team_id && v.channel_id);
      const isChat = Boolean(v.chat_id);
      return isChannel !== isChat;
    },
    "Provide exactly one target: team_id+channel_id (channel message) OR chat_id (chat message) — not both",
  );

const uploadAttachmentParams = z
  .object({
    team_id: z.string().min(1).optional(),
    channel_id: z.string().min(1).optional(),
    chat_id: z.string().min(1).optional(),
    filename: z.string().min(1, "filename required"),
    content_base64: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    mime_type: z.string().min(1).optional(),
  })
  .refine(
    (v) => Boolean(v.content_base64) !== Boolean(v.path),
    "Provide exactly one of content_base64 or path",
  )
  .refine(
    (v) => {
      const isChannel = Boolean(v.team_id && v.channel_id);
      const isChat = Boolean(v.chat_id);
      return isChannel !== isChat;
    },
    "Provide exactly one target: team_id+channel_id (channel post) OR chat_id (chat post) — not both",
  );

function getMessageAttachment(
  msg: GraphMessage,
  attachmentId: string,
): { contentUrl: string; name: string | null; contentType: string | null } | null {
  const list = msg.attachments ?? [];
  const hit = list.find((a) => a.id === attachmentId);
  if (!hit) return null;
  if (!hit.contentUrl) return null;
  return {
    contentUrl: hit.contentUrl,
    name: hit.name ?? null,
    contentType: hit.contentType ?? null,
  };
}

function readBytesFromInput(
  contentBase64: string | undefined,
  filePath: string | undefined,
): Uint8Array {
  if (contentBase64) {
    return new Uint8Array(Buffer.from(contentBase64, "base64"));
  }
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!checkPathContainment(resolved, process.cwd())) {
      throw new ConnectorError(
        "VALIDATION_ERROR",
        `Path '${filePath}' resolves outside the current working directory; refusing to upload`,
        false,
      );
    }
    return new Uint8Array(fs.readFileSync(resolved));
  }
  // Schema guarantees one of these is present.
  throw new ConnectorError(
    "VALIDATION_ERROR",
    "Provide exactly one of content_base64 or path",
    false,
  );
}

export function buildAttachmentsActions(): TeamsActions {
  return {
    get_attachment: {
      description: "Download a message attachment (channel or chat) by id",
      params: getAttachmentParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getAttachmentParams>, ctx) => {
        let msg;
        if (p.team_id && p.channel_id) {
          const r = await ctx.sdk.getMessage(p.team_id, p.channel_id, p.message_id);
          throwIfHttpError(r);
          msg = r.data;
        } else if (p.chat_id) {
          const r = await ctx.sdk.getChatMessage(p.chat_id, p.message_id);
          throwIfHttpError(r);
          msg = r.data;
        } else {
          throw new ConnectorError(
            "VALIDATION_ERROR",
            "Either team_id+channel_id or chat_id must be supplied",
            false,
          );
        }
        const ref = getMessageAttachment(msg, p.attachment_id);
        if (!ref) {
          throw new ConnectorError(
            "NOT_FOUND",
            `Attachment '${p.attachment_id}' not found on message '${p.message_id}'`,
            false,
            404,
          );
        }
        // The contentUrl is an absolute OneDrive / SharePoint URL with its
        // own short-lived auth — use `fetchAttachment` for capped + extracted
        // download. No bearer required for these signed URLs.
        let attachment;
        try {
          attachment = await fetchAttachment(ref.contentUrl);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isDeterministic =
            message.includes("invalid URL scheme") ||
            (err instanceof Error && err.constructor?.name === "FetchCapExceeded");
          throw new ConnectorError(
            isDeterministic ? "VALIDATION_ERROR" : "CONNECTION_ERROR",
            `Failed to fetch attachment URL: ${message}`,
            !isDeterministic,
          );
        }
        return {
          message_id: p.message_id,
          attachment_id: p.attachment_id,
          filename: sanitizeLabel(ref.name ?? attachment.filename, 255),
          media_type: attachment.contentType,
          size_bytes: attachment.sizeBytes,
          checksum: attachment.checksum,
          extracted: attachment.extracted,
          source_url: attachment.sourceUrl,
        };
      },
    },

    upload_attachment: {
      description:
        "Upload a file to OneDrive and post a Teams message referencing it (channel or chat target)",
      params: uploadAttachmentParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof uploadAttachmentParams>, ctx) => {
        const bytes = readBytesFromInput(p.content_base64, p.path);
        const safeName = sanitizeLabel(p.filename, 255);
        const mime = p.mime_type ?? "application/octet-stream";
        const uploadRes = await ctx.sdk.uploadAttachmentToOneDrive(
          safeName,
          bytes,
          mime,
        );
        throwIfHttpError(uploadRes);
        const drive = uploadRes.data;
        const driveItemId = drive.id;
        const driveItemUrl = drive.webUrl ?? "";
        const messageBody = {
          body: {
            contentType: "html",
            content: `<attachment id="${driveItemId}"></attachment>`,
          },
          attachments: [
            {
              id: driveItemId,
              contentType: "reference",
              contentUrl: driveItemUrl,
              name: drive.name ?? safeName,
            },
          ],
        };
        let postedMessage;
        if (p.team_id && p.channel_id) {
          const r = await ctx.sdk.postChannelMessage(
            p.team_id,
            p.channel_id,
            messageBody,
          );
          throwIfHttpError(r);
          postedMessage = r.data;
        } else if (p.chat_id) {
          const r = await ctx.sdk.postChatMessage(p.chat_id, messageBody);
          throwIfHttpError(r);
          postedMessage = r.data;
        } else {
          throw new ConnectorError(
            "VALIDATION_ERROR",
            "Either team_id+channel_id or chat_id must be supplied",
            false,
          );
        }
        return {
          drive_item_id: driveItemId,
          drive_item_url: driveItemUrl,
          drive_item_name: drive.name ?? safeName,
          size_bytes: drive.size ?? bytes.byteLength,
          message_id: postedMessage.id,
          target: p.chat_id
            ? { kind: "chat", chat_id: p.chat_id }
            : { kind: "channel", team_id: p.team_id, channel_id: p.channel_id },
        };
      },
    },
  };
}
