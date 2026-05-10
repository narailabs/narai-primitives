/**
 * @narai/linear-agent-connector — read + write Linear connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector` instance; `buildLinearConnector(overrides?)` is exposed
 * for tests that want to inject a fake Linear client.
 *
 * Linear specifics:
 * - GraphQL only (single endpoint: https://api.linear.app/graphql)
 * - Auth: `Authorization: <api_key>` (no Bearer — Linear-specific)
 * - Native markdown for issue descriptions and comments — no ADF
 * - No native attachment hosting; `attachment_link` creates URL pointers
 */
import {
  createConnector,
  sanitizeLabel,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { z } from "zod";
import {
  LinearClient,
  loadLinearCredentials,
  type LinearResult,
} from "./lib/linear_client.js";
import { LinearError } from "./lib/linear_error.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

// Matches both `ENG-123` identifiers and UUIDs (32+ hex chars with optional dashes)
const issueIdOrIdentifierSchema = z
  .string()
  .min(1)
  .regex(
    /^([A-Z][A-Z0-9]+-\d+|[0-9a-fA-F-]{32,})$/,
    "Expected an identifier like ENG-123 or a Linear UUID",
  );

const issueUuidSchema = z
  .string()
  .regex(/^[0-9a-fA-F-]{32,}$/, "Invalid Linear UUID");

const teamKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+$/, "Invalid team_key — uppercase alphanumeric");

const getIssueParams = z.object({ id: issueIdOrIdentifierSchema });

const searchIssuesParams = z.object({
  team_key: teamKeySchema.optional(),
  state: z.string().optional(),
  assignee_email: z.string().email().optional(),
  text: z.string().optional(),
  max_results: z.number().int().positive().default(50),
});

const getProjectParams = z.object({ id: issueUuidSchema });

const getTeamParams = z.object({ key_or_id: z.string().min(1) });

const getCommentsParams = z.object({
  issue_id: issueIdOrIdentifierSchema,
  max_results: z.number().int().positive().default(50),
});

const listAttachmentsParams = z.object({ issue_id: issueIdOrIdentifierSchema });

const getAttachmentParams = z.object({ attachment_id: issueUuidSchema });

const createIssueParams = z.object({
  team_id: issueUuidSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  assignee_id: issueUuidSchema.optional(),
  label_ids: z.array(issueUuidSchema).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  parent_id: issueUuidSchema.optional(),
});

const updateIssueParams = z.object({
  id: issueIdOrIdentifierSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  assignee_id: issueUuidSchema.optional(),
  state_id: issueUuidSchema.optional(),
  priority: z.number().int().min(0).max(4).optional(),
});

const archiveIssueParams = z.object({ id: issueIdOrIdentifierSchema });

const addCommentParams = z.object({
  issue_id: issueIdOrIdentifierSchema,
  body: z.string().min(1),
});

const updateCommentParams = z.object({
  comment_id: issueUuidSchema,
  body: z.string().min(1),
});

const deleteCommentParams = z.object({ comment_id: issueUuidSchema });

const attachmentLinkParams = z.object({
  issue_id: issueIdOrIdentifierSchema,
  title: z.string().min(1),
  url: z.string().url(),
  subtitle: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation: Linear client codes → toolkit canonical codes
// ───────────────────────────────────────────────────────────────────────────

const CODE_MAP: Record<string, ErrorCode> = {
  UNAUTHORIZED: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "CONNECTION_ERROR",
  SERVER_ERROR: "CONNECTION_ERROR",
  BAD_REQUEST: "VALIDATION_ERROR",
  HTTP_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  GRAPHQL_ERROR: "VALIDATION_ERROR",
};

function throwIfError<T>(
  result: LinearResult<T>,
): asserts result is Extract<LinearResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new LinearError(
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
  sdk?: () => Promise<LinearClient>;
  credentials?: () => Promise<Record<string, unknown>>;
  defaultPolicy?: import("narai-primitives/toolkit").PolicyRules;
}

export function buildLinearConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadLinearCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<LinearClient> => {
    const creds = await loadLinearCredentials();
    if (!creds) {
      throw new LinearError(
        "CONFIG_ERROR",
        "Linear credentials not configured. Set LINEAR_API_KEY or register a " +
          "credential provider via narai-primitives/credentials.",
        false,
      );
    }
    return new LinearClient(creds);
  };

  return createConnector<LinearClient>({
    name: "linear",
    version: "1.0.0",
    scope: () => "linear",
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    ...(overrides.defaultPolicy !== undefined
      ? { defaultPolicy: overrides.defaultPolicy }
      : {}),
    actions: {

      // ── Read actions ────────────────────────────────────────────────────

      get_issue: {
        description: "Fetch a Linear issue by identifier (e.g. ENG-123) or UUID",
        params: getIssueParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getIssueParams>, ctx) => {
          const result = await ctx.sdk.getIssue(p.id);
          throwIfError(result);
          const issue = result.data.issue;
          if (!issue) {
            throw new LinearError("NOT_FOUND", `Issue '${p.id}' not found`, false, 404);
          }
          return {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description ?? null,
            priority: issue.priority,
            url: issue.url,
            archived_at: issue.archivedAt ?? null,
            created_at: issue.createdAt,
            updated_at: issue.updatedAt,
            state: issue.state ?? null,
            assignee: issue.assignee ?? null,
            team: issue.team ?? null,
            labels: issue.labels.nodes,
          };
        },
      },

      search_issues: {
        description: "Search Linear issues by team, state, assignee, or text",
        params: searchIssuesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof searchIssuesParams>, ctx) => {
          const searchFilter: {
            team_key?: string;
            state?: string;
            assignee_email?: string;
            text?: string;
            max_results: number;
          } = { max_results: p.max_results };
          if (p.team_key !== undefined) searchFilter.team_key = p.team_key;
          if (p.state !== undefined) searchFilter.state = p.state;
          if (p.assignee_email !== undefined) searchFilter.assignee_email = p.assignee_email;
          if (p.text !== undefined) searchFilter.text = p.text;
          const result = await ctx.sdk.searchIssues(searchFilter);
          throwIfError(result);
          const nodes = result.data.issues.nodes;
          return {
            total: nodes.length,
            issues: nodes.map((i) => ({
              id: i.id,
              identifier: i.identifier,
              title: i.title,
              priority: i.priority,
              url: i.url,
              state: i.state ?? null,
              assignee: i.assignee ?? null,
              team: i.team ?? null,
              created_at: i.createdAt,
              updated_at: i.updatedAt,
            })),
            truncated: result.data.issues.pageInfo.hasNextPage,
          };
        },
      },

      get_project: {
        description: "Fetch a Linear project by UUID",
        params: getProjectParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getProjectParams>, ctx) => {
          const result = await ctx.sdk.getProject(p.id);
          throwIfError(result);
          const project = result.data.project;
          if (!project) {
            throw new LinearError("NOT_FOUND", `Project '${p.id}' not found`, false, 404);
          }
          return {
            id: project.id,
            name: project.name,
            description: project.description ?? null,
            state: project.state,
            start_date: project.startDate ?? null,
            target_date: project.targetDate ?? null,
            created_at: project.createdAt,
            updated_at: project.updatedAt,
          };
        },
      },

      get_team: {
        description: "Fetch a Linear team by key (e.g. ENG) or UUID",
        params: getTeamParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getTeamParams>, ctx) => {
          const result = await ctx.sdk.getTeam(p.key_or_id);
          throwIfError(result);
          const team = result.data.team;
          return {
            id: team.id,
            key: team.key,
            name: team.name,
            description: team.description ?? null,
          };
        },
      },

      get_comments: {
        description: "List comments on a Linear issue",
        params: getCommentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getCommentsParams>, ctx) => {
          const result = await ctx.sdk.getComments(p.issue_id, p.max_results);
          throwIfError(result);
          if (!result.data.issue) {
            throw new LinearError("NOT_FOUND", `Issue '${p.issue_id}' not found`, false, 404);
          }
          const { nodes, pageInfo } = result.data.issue.comments;
          return {
            issue_id: p.issue_id,
            total: nodes.length,
            comments: nodes.map((c) => ({
              comment_id: c.id,
              body: c.body,
              author: c.user?.displayName ?? null,
              created_at: c.createdAt,
              updated_at: c.updatedAt,
            })),
            truncated: pageInfo.hasNextPage,
          };
        },
      },

      list_attachments: {
        description: "List attachment URLs linked to a Linear issue",
        params: listAttachmentsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listAttachmentsParams>, ctx) => {
          const result = await ctx.sdk.listAttachments(p.issue_id);
          throwIfError(result);
          if (!result.data.issue) {
            throw new LinearError("NOT_FOUND", `Issue '${p.issue_id}' not found`, false, 404);
          }
          const nodes = result.data.issue.attachments.nodes;
          return {
            issue_id: p.issue_id,
            total: nodes.length,
            attachments: nodes.map((a) => ({
              attachment_id: a.id,
              title: a.title,
              subtitle: a.subtitle ?? null,
              url: a.url,
              created_at: a.createdAt,
              creator: a.creator?.displayName ?? null,
            })),
          };
        },
      },

      get_attachment: {
        description: "Fetch and extract the contents of a Linear attachment URL",
        params: getAttachmentParams,
        classify: { kind: "read" },
        handler: async (_p: z.infer<typeof getAttachmentParams>, _ctx) => {
          // Linear attachments are URL pointers to externally-hosted files.
          // We cannot look up the URL by attachment_id alone without an issue_id.
          // This action is a proxy: callers must supply the URL from list_attachments.
          // Since GraphQL doesn't expose a top-level attachment query in the public API,
          // we expose a direct URL fetch — the attachment_id serves as a trace key.
          throw new LinearError(
            "BAD_REQUEST",
            "get_attachment requires a direct URL. Use list_attachments to obtain " +
              "the URL for attachment_id, then use the toolkit's fetchAttachment utility directly.",
            false,
            400,
          );
        },
      },

      // ── Write actions ───────────────────────────────────────────────────

      create_issue: {
        description: "Create a new Linear issue",
        params: createIssueParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof createIssueParams>, ctx) => {
          const input: Record<string, unknown> = {
            teamId: p.team_id,
            title: p.title,
          };
          if (p.description !== undefined) input["description"] = p.description;
          if (p.assignee_id !== undefined) input["assigneeId"] = p.assignee_id;
          if (p.label_ids !== undefined) input["labelIds"] = p.label_ids;
          if (p.priority !== undefined) input["priority"] = p.priority;
          if (p.parent_id !== undefined) input["parentId"] = p.parent_id;
          const result = await ctx.sdk.createIssue(input as Parameters<LinearClient["createIssue"]>[0]);
          throwIfError(result);
          const { success, issue } = result.data.issueCreate;
          if (!success || !issue) {
            throw new LinearError("SERVER_ERROR", "issueCreate returned success=false", false);
          }
          return {
            id: issue.id,
            identifier: issue.identifier,
            url: issue.url,
            title: issue.title,
            created_at: issue.createdAt,
          };
        },
      },

      update_issue: {
        description: "Update fields on an existing Linear issue",
        params: updateIssueParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof updateIssueParams>, ctx) => {
          const input: Record<string, unknown> = {};
          if (p.title !== undefined) input["title"] = p.title;
          if (p.description !== undefined) input["description"] = p.description;
          if (p.assignee_id !== undefined) input["assigneeId"] = p.assignee_id;
          if (p.state_id !== undefined) input["stateId"] = p.state_id;
          if (p.priority !== undefined) input["priority"] = p.priority;
          const result = await ctx.sdk.updateIssue(p.id, input as Parameters<LinearClient["updateIssue"]>[1]);
          throwIfError(result);
          const { success, issue } = result.data.issueUpdate;
          if (!success) {
            throw new LinearError("SERVER_ERROR", "issueUpdate returned success=false", false);
          }
          return {
            id: issue.id,
            identifier: issue.identifier,
            updated_at: issue.updatedAt,
            updated: true,
          };
        },
      },

      archive_issue: {
        description: "Archive a Linear issue (Linear's soft-delete via issueArchive mutation)",
        params: archiveIssueParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof archiveIssueParams>, ctx) => {
          const result = await ctx.sdk.archiveIssue(p.id);
          throwIfError(result);
          const { success } = result.data.issueArchive;
          if (!success) {
            throw new LinearError("SERVER_ERROR", "issueArchive returned success=false", false);
          }
          return { id: p.id, archived: true };
        },
      },

      add_comment: {
        description: "Add a markdown comment to a Linear issue",
        params: addCommentParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof addCommentParams>, ctx) => {
          const result = await ctx.sdk.addComment({
            issueId: p.issue_id,
            body: p.body,
          });
          throwIfError(result);
          const { success, comment } = result.data.commentCreate;
          if (!success || !comment) {
            throw new LinearError("SERVER_ERROR", "commentCreate returned success=false", false);
          }
          return {
            comment_id: comment.id,
            body: comment.body,
            author: comment.user?.displayName ?? null,
            created_at: comment.createdAt,
          };
        },
      },

      update_comment: {
        description: "Update an existing comment on a Linear issue",
        params: updateCommentParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof updateCommentParams>, ctx) => {
          const result = await ctx.sdk.updateComment(p.comment_id, { body: p.body });
          throwIfError(result);
          const { success, comment } = result.data.commentUpdate;
          if (!success) {
            throw new LinearError("SERVER_ERROR", "commentUpdate returned success=false", false);
          }
          return {
            comment_id: comment.id,
            body: comment.body,
            updated_at: comment.updatedAt,
            updated: true,
          };
        },
      },

      delete_comment: {
        description: "Delete a comment from a Linear issue",
        params: deleteCommentParams,
        classify: { kind: "write", aspects: ["delete"] },
        handler: async (p: z.infer<typeof deleteCommentParams>, ctx) => {
          const result = await ctx.sdk.deleteComment(p.comment_id);
          throwIfError(result);
          const { success } = result.data.commentDelete;
          if (!success) {
            throw new LinearError("SERVER_ERROR", "commentDelete returned success=false", false);
          }
          return { comment_id: p.comment_id, deleted: true };
        },
      },

      attachment_link: {
        description: "Link an external URL as an Attachment object on a Linear issue",
        params: attachmentLinkParams,
        classify: { kind: "write" },
        handler: async (p: z.infer<typeof attachmentLinkParams>, ctx) => {
          const input: Record<string, unknown> = {
            issueId: p.issue_id,
            title: p.title,
            url: p.url,
          };
          if (p.subtitle !== undefined) input["subtitle"] = p.subtitle;
          if (p.metadata !== undefined) input["metadata"] = p.metadata;
          const result = await ctx.sdk.attachmentLink(input as Parameters<LinearClient["attachmentLink"]>[0]);
          throwIfError(result);
          const { success, attachment } = result.data.attachmentCreate;
          if (!success || !attachment) {
            throw new LinearError("SERVER_ERROR", "attachmentCreate returned success=false", false);
          }
          return {
            attachment_id: attachment.id,
            title: sanitizeLabel(attachment.title, 255),
            url: attachment.url,
            created_at: attachment.createdAt,
          };
        },
      },
    },
    mapError: (err) => {
      if (err instanceof LinearError) {
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
const connector = buildLinearConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for advanced consumers.
export {
  LinearClient,
  loadLinearCredentials,
  type LinearClientOptions,
  type LinearResult,
} from "./lib/linear_client.js";
export { LinearError } from "./lib/linear_error.js";
