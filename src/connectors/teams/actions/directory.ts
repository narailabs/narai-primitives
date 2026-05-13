/**
 * Directory read actions: teams the user has joined, channels in a team,
 * 1:1 / group chats the user is part of, and the org user directory.
 * Every action is `{ kind: "read" }`.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { TeamsActions } from "./_types.js";
import { MAX_RESULTS_DEFAULT, capMax } from "./_pagination.js";

const teamIdField = z.string().min(1, "team_id required");
const channelIdField = z.string().min(1, "channel_id required");

const listTeamsParams = z.object({
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const listChannelsParams = z.object({
  team_id: teamIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getChannelParams = z.object({
  team_id: teamIdField,
  channel_id: channelIdField,
});

const listChatsParams = z.object({
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const listUsersParams = z.object({
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getUserParams = z.object({
  user_id: z.string().min(1, "user_id or userPrincipalName required"),
});

export function buildDirectoryActions(): TeamsActions {
  return {
    list_teams: {
      description: "List the Teams the signed-in user has joined",
      params: listTeamsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listTeamsParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listJoinedTeams(max);
        throwIfHttpError(r);
        return {
          total: r.data.items.length,
          truncated: r.data.truncated,
          teams: r.data.items.map((t) => ({
            id: t.id,
            display_name: t.displayName ?? "",
            description: t.description ?? "",
            web_url: t.webUrl ?? "",
          })),
        };
      },
    },

    list_channels: {
      description: "List the channels in a Team",
      params: listChannelsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listChannelsParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listChannels(p.team_id, max);
        throwIfHttpError(r);
        return {
          team_id: p.team_id,
          total: r.data.items.length,
          truncated: r.data.truncated,
          channels: r.data.items.map((c) => ({
            id: c.id,
            display_name: c.displayName ?? "",
            description: c.description ?? "",
            membership_type: c.membershipType ?? "",
            web_url: c.webUrl ?? "",
            email: c.email ?? null,
          })),
        };
      },
    },

    get_channel: {
      description: "Fetch metadata for a single channel",
      params: getChannelParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getChannelParams>, ctx) => {
        const r = await ctx.sdk.getChannel(p.team_id, p.channel_id);
        throwIfHttpError(r);
        const c = r.data;
        return {
          id: c.id,
          team_id: p.team_id,
          display_name: c.displayName ?? "",
          description: c.description ?? "",
          membership_type: c.membershipType ?? "",
          web_url: c.webUrl ?? "",
          email: c.email ?? null,
        };
      },
    },

    list_chats: {
      description: "List the 1:1 and group chats the signed-in user is part of",
      params: listChatsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listChatsParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listChats(max);
        throwIfHttpError(r);
        return {
          total: r.data.items.length,
          truncated: r.data.truncated,
          chats: r.data.items.map((c) => ({
            id: c.id,
            topic: c.topic ?? null,
            chat_type: c.chatType ?? "",
            created_at: c.createdDateTime ?? null,
            last_updated: c.lastUpdatedDateTime ?? null,
            web_url: c.webUrl ?? "",
          })),
        };
      },
    },

    list_users: {
      description: "List directory users in the tenant",
      params: listUsersParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listUsersParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listUsers(max);
        throwIfHttpError(r);
        return {
          total: r.data.items.length,
          truncated: r.data.truncated,
          users: r.data.items.map((u) => ({
            id: u.id,
            display_name: u.displayName ?? "",
            mail: u.mail ?? null,
            user_principal_name: u.userPrincipalName ?? "",
            job_title: u.jobTitle ?? null,
          })),
        };
      },
    },

    get_user: {
      description: "Fetch a directory user by id or userPrincipalName",
      params: getUserParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getUserParams>, ctx) => {
        const r = await ctx.sdk.getUser(p.user_id);
        throwIfHttpError(r);
        const u = r.data;
        return {
          id: u.id,
          display_name: u.displayName ?? "",
          mail: u.mail ?? null,
          user_principal_name: u.userPrincipalName ?? "",
          job_title: u.jobTitle ?? null,
        };
      },
    },
  };
}
