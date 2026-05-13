/**
 * Messages action specs: channel + chat read / post / reply / update / delete,
 * reactions, and a Graph `/search/query` wrapper.
 *
 * Classification:
 *   - list_* / get_* / search_messages   : read
 *   - post_* / reply_* / update_* / add_reaction : write
 *   - delete_message / remove_reaction          : write + delete aspect
 *
 * The connector's `ContentInput` union (plain / markdown / html) is rendered
 * into the Graph `body` shape via `contentInputToGraphBody`. Markdown is
 * converted to a small HTML subset via `markdownToHtml` — no sanitizer is
 * applied to `html` input for v0; callers must trust their source.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { TeamsActions } from "./_types.js";
import { contentInput, contentInputToGraphBody } from "./_types.js";
import type {
  GraphMessage,
  GraphSearchHit,
  GraphMessageAttachment,
} from "../lib/teams_client.js";
import { MAX_RESULTS_DEFAULT, capMax } from "./_pagination.js";

const teamIdField = z.string().min(1, "team_id required");
const channelIdField = z.string().min(1, "channel_id required");
const chatIdField = z.string().min(1, "chat_id required");
const msgIdField = z.string().min(1, "message_id required");
const reactionTypeField = z.string().min(1, "reaction_type required");

// Reference to an already-uploaded OneDrive item to attach to a posted msg.
const messageAttachmentRef = z.object({
  id: z.string().min(1),
  contentUrl: z.string().url(),
  name: z.string().optional(),
});

const listChannelMessagesParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getMessageRepliesParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  message_id: msgIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const listChatMessagesParams = z.object({
  chat_id: chatIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const searchMessagesParams = z.object({
  query: z.string().min(1, "search_messages requires a non-empty 'query'"),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const postChannelMessageParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  body: contentInput,
  attachments: z.array(messageAttachmentRef).optional(),
});

const replyToChannelMessageParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  message_id: msgIdField,
  body: contentInput,
  attachments: z.array(messageAttachmentRef).optional(),
});

const postChatMessageParams = z.object({
  chat_id: chatIdField,
  body: contentInput,
  attachments: z.array(messageAttachmentRef).optional(),
});

const updateMessageParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  message_id: msgIdField,
  body: contentInput,
});

const deleteMessageParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  message_id: msgIdField,
});

const reactionParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
  message_id: msgIdField,
  reaction_type: reactionTypeField,
});

function messageEnvelope(m: GraphMessage): Record<string, unknown> {
  return {
    id: m.id,
    reply_to_id: m.replyToId ?? null,
    created_at: m.createdDateTime ?? null,
    last_modified: m.lastModifiedDateTime ?? null,
    deleted_at: m.deletedDateTime ?? null,
    subject: m.subject ?? null,
    importance: m.importance ?? "normal",
    web_url: m.webUrl ?? null,
    from: m.from?.user?.displayName ?? "",
    from_id: m.from?.user?.id ?? null,
    body_content: m.body?.content ?? "",
    body_type: m.body?.contentType ?? "text",
    attachments: (m.attachments ?? []).map((a: GraphMessageAttachment) => ({
      id: a.id,
      content_type: a.contentType ?? "",
      content_url: a.contentUrl ?? null,
      name: a.name ?? null,
    })),
  };
}

function buildPostBody(
  content: z.infer<typeof contentInput>,
  attachments: z.infer<typeof messageAttachmentRef>[] | undefined,
): Record<string, unknown> {
  const graphBody = contentInputToGraphBody(content);
  const body: Record<string, unknown> = { body: graphBody };
  if (attachments && attachments.length > 0) {
    // For each attachment, include a `<attachment id=...>` chip in the
    // message body so Teams renders it inline (Graph requires this when
    // posting reference attachments).
    body.attachments = attachments.map((a) => ({
      id: a.id,
      contentType: "reference",
      contentUrl: a.contentUrl,
      name: a.name ?? null,
    }));
    const chips = attachments
      .map((a) => `<attachment id="${a.id}"></attachment>`)
      .join("");
    if (graphBody.contentType === "html") {
      graphBody.content = `${graphBody.content}${chips}`;
    } else {
      // Promote to HTML so the attachment chip is rendered.
      graphBody.contentType = "html";
      graphBody.content = `${graphBody.content}${chips}`;
    }
    body.body = graphBody;
  }
  return body;
}

function hitToSummary(hit: GraphSearchHit): Record<string, unknown> {
  const res = hit.resource ?? {};
  return {
    hit_id: hit.hitId,
    rank: hit.rank ?? null,
    summary: hit.summary ?? "",
    message_id: res.id ?? null,
    created_at: res.createdDateTime ?? null,
    web_url: res.webLink ?? null,
    from: res.from?.user?.displayName ?? "",
    from_id: res.from?.user?.id ?? null,
    chat_id: res.chatId ?? null,
    team_id: res.channelIdentity?.teamId ?? null,
    channel_id: res.channelIdentity?.channelId ?? null,
    body_preview: res.body?.content ?? "",
  };
}

export function buildMessagesActions(): TeamsActions {
  return {
    list_channel_messages: {
      description: "List messages posted to a channel",
      params: listChannelMessagesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listChannelMessagesParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listChannelMessages(p.team_id, p.channel_id, max);
        throwIfHttpError(r);
        return {
          team_id: p.team_id,
          channel_id: p.channel_id,
          total: r.data.items.length,
          truncated: r.data.truncated,
          messages: r.data.items.map(messageEnvelope),
        };
      },
    },

    get_message_replies: {
      description: "List replies on a channel message",
      params: getMessageRepliesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getMessageRepliesParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.getMessageReplies(
          p.team_id,
          p.channel_id,
          p.message_id,
          max,
        );
        throwIfHttpError(r);
        return {
          team_id: p.team_id,
          channel_id: p.channel_id,
          message_id: p.message_id,
          total: r.data.items.length,
          truncated: r.data.truncated,
          replies: r.data.items.map(messageEnvelope),
        };
      },
    },

    list_chat_messages: {
      description: "List messages in a 1:1 or group chat",
      params: listChatMessagesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listChatMessagesParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listChatMessages(p.chat_id, max);
        throwIfHttpError(r);
        return {
          chat_id: p.chat_id,
          total: r.data.items.length,
          truncated: r.data.truncated,
          messages: r.data.items.map(messageEnvelope),
        };
      },
    },

    search_messages: {
      description: "Search Teams messages across channels and chats",
      params: searchMessagesParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof searchMessagesParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.searchMessages(p.query, max);
        throwIfHttpError(r);
        const hits: GraphSearchHit[] = [];
        let moreAvailable = false;
        for (const resp of r.data.value ?? []) {
          for (const container of resp.hitsContainers ?? []) {
            for (const h of container.hits ?? []) hits.push(h);
            if (container.moreResultsAvailable) moreAvailable = true;
          }
        }
        return {
          query: p.query,
          total: hits.length,
          truncated: moreAvailable,
          hits: hits.map(hitToSummary),
        };
      },
    },

    post_channel_message: {
      description: "Post a new message to a channel",
      params: postChannelMessageParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof postChannelMessageParams>, ctx) => {
        const body = buildPostBody(p.body, p.attachments);
        const r = await ctx.sdk.postChannelMessage(p.team_id, p.channel_id, body);
        throwIfHttpError(r);
        return messageEnvelope(r.data);
      },
    },

    reply_to_channel_message: {
      description: "Reply to an existing channel message",
      params: replyToChannelMessageParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof replyToChannelMessageParams>, ctx) => {
        const body = buildPostBody(p.body, p.attachments);
        const r = await ctx.sdk.replyToChannelMessage(
          p.team_id,
          p.channel_id,
          p.message_id,
          body,
        );
        throwIfHttpError(r);
        return messageEnvelope(r.data);
      },
    },

    post_chat_message: {
      description: "Post a message to a 1:1 or group chat",
      params: postChatMessageParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof postChatMessageParams>, ctx) => {
        const body = buildPostBody(p.body, p.attachments);
        const r = await ctx.sdk.postChatMessage(p.chat_id, body);
        throwIfHttpError(r);
        return messageEnvelope(r.data);
      },
    },

    update_message: {
      description: "Update the body of an existing channel message",
      params: updateMessageParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof updateMessageParams>, ctx) => {
        const body = buildPostBody(p.body, undefined);
        const r = await ctx.sdk.updateMessage(
          p.team_id,
          p.channel_id,
          p.message_id,
          body,
        );
        throwIfHttpError(r);
        return { ...messageEnvelope(r.data), updated: true };
      },
    },

    delete_message: {
      description: "Soft-delete a channel message",
      params: deleteMessageParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p: z.infer<typeof deleteMessageParams>, ctx) => {
        const r = await ctx.sdk.softDeleteMessage(
          p.team_id,
          p.channel_id,
          p.message_id,
        );
        throwIfHttpError(r);
        return {
          team_id: p.team_id,
          channel_id: p.channel_id,
          message_id: p.message_id,
          deleted: true,
        };
      },
    },

    add_reaction: {
      description: "Add a reaction emoji to a channel message",
      params: reactionParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof reactionParams>, ctx) => {
        const r = await ctx.sdk.setReaction(
          p.team_id,
          p.channel_id,
          p.message_id,
          p.reaction_type,
        );
        throwIfHttpError(r);
        return {
          team_id: p.team_id,
          channel_id: p.channel_id,
          message_id: p.message_id,
          reaction_type: p.reaction_type,
          added: true,
        };
      },
    },

    remove_reaction: {
      description: "Remove a reaction emoji from a channel message",
      params: reactionParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p: z.infer<typeof reactionParams>, ctx) => {
        const r = await ctx.sdk.unsetReaction(
          p.team_id,
          p.channel_id,
          p.message_id,
          p.reaction_type,
        );
        throwIfHttpError(r);
        return {
          team_id: p.team_id,
          channel_id: p.channel_id,
          message_id: p.message_id,
          reaction_type: p.reaction_type,
          removed: true,
        };
      },
    },
  };
}
