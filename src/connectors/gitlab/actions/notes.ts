/**
 * Unified note actions: add_note, update_note, delete_note.
 * All three accept a noteable_type discriminator ("issue" | "merge_request")
 * and route to /issues/:iid/notes or /merge_requests/:iid/notes accordingly.
 *
 * add_note also accepts an optional position payload for MR diff comments.
 * Schema enforces: position is only valid when noteable_type === "merge_request".
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GitlabActionDeps, GitlabActions } from "./_types.js";
import { namespaceField, projectField, noteIdField, shaField, filePathField } from "./_fields.js";

// ── Param schemas ──────────────────────────────────────────────────────────

const baseNoteParams = z.object({
  namespace: namespaceField,
  project: projectField,
  noteable_type: z.enum(["issue", "merge_request"]),
  noteable_iid: z.coerce.number().int().positive(),
});

const positionSchema = z.object({
  base_sha: shaField,
  start_sha: shaField,
  head_sha: shaField,
  position_type: z.literal("text"),
  new_path: filePathField,
  old_path: filePathField.optional(),
  new_line: z.coerce.number().int().positive().optional(),
  old_line: z.coerce.number().int().positive().optional(),
});

const addNoteParams = baseNoteParams
  .extend({
    body: z.string().min(1),
    position: positionSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.position !== undefined && val.noteable_type !== "merge_request") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["position"],
        message: "position is only valid when noteable_type is 'merge_request'",
      });
    }
  });

const updateNoteParams = baseNoteParams.extend({
  note_id: noteIdField,
  body: z.string().min(1),
});

const deleteNoteParams = baseNoteParams.extend({
  note_id: noteIdField,
});

// ── Factory ────────────────────────────────────────────────────────────────

export function buildNotesActions(_deps: GitlabActionDeps): GitlabActions {
  return {
    add_note: {
      description: "Add a note (comment) to a GitLab issue or merge request",
      params: addNoteParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof addNoteParams>, ctx) => {
        const noteBody: { body: string; position?: z.infer<typeof positionSchema> } = {
          body: p.body,
        };
        if (p.position !== undefined) noteBody.position = p.position;
        const r = await ctx.sdk.addNote(
          p.namespace,
          p.project,
          p.noteable_type,
          p.noteable_iid,
          noteBody,
        );
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          body: d.body,
          author: d.author?.username ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
        };
      },
    },

    update_note: {
      description: "Update an existing note on a GitLab issue or merge request",
      params: updateNoteParams,
      classify: { kind: "write" },
      handler: async (p: z.infer<typeof updateNoteParams>, ctx) => {
        const r = await ctx.sdk.updateNote(
          p.namespace,
          p.project,
          p.noteable_type,
          p.noteable_iid,
          p.note_id,
          { body: p.body },
        );
        throwIfHttpError(r);
        const d = r.data;
        return {
          id: d.id,
          body: d.body,
          author: d.author?.username ?? "",
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
        };
      },
    },

    delete_note: {
      description: "Delete a note from a GitLab issue or merge request",
      params: deleteNoteParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p: z.infer<typeof deleteNoteParams>, ctx) => {
        const r = await ctx.sdk.deleteNote(
          p.namespace,
          p.project,
          p.noteable_type,
          p.noteable_iid,
          p.note_id,
        );
        throwIfHttpError(r);
        return {
          note_id: p.note_id,
          deleted: true,
        };
      },
    },
  };
}
