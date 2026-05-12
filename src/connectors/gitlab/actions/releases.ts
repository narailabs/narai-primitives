/**
 * Release write actions: create / update / delete + delete_release_link.
 * Read actions (list_release_links, get_release_link) live in reads.ts.
 * Asset binary upload is out of scope — GitLab releases use links, not
 * multipart-uploaded assets.
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GitlabActionDeps, GitlabActions } from "./_types.js";
import { namespaceField, projectField, releaseTagField, linkIdField } from "./_fields.js";

const projectParams = z.object({
  namespace: namespaceField,
  project: projectField,
});

const assetLinkSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  link_type: z.enum(["other", "runbook", "image", "package"]).optional(),
});

const createReleaseParams = projectParams.extend({
  tag_name: releaseTagField,
  name: z.string().min(1),
  description: z.string().optional(),
  ref: z.string().min(1).optional(),
  assets: z
    .object({ links: z.array(assetLinkSchema) })
    .optional(),
});

const updateReleaseParams = projectParams.extend({
  tag_name: releaseTagField,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  milestones: z.array(z.string()).optional(),
});

const deleteReleaseParams = projectParams.extend({
  tag_name: releaseTagField,
});

const deleteReleaseLinkParams = projectParams.extend({
  tag_name: releaseTagField,
  link_id: linkIdField,
});

export function buildReleasesActions(_deps: GitlabActionDeps): GitlabActions {
  return {
    create_release: {
      description: "Create a GitLab release for an existing or new tag",
      params: createReleaseParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          tag_name: string;
          name: string;
          description?: string;
          ref?: string;
          assets?: { links: { name: string; url: string; link_type?: string }[] };
        } = { tag_name: p.tag_name, name: p.name };
        if (p.description !== undefined) body.description = p.description;
        if (p.ref !== undefined) body.ref = p.ref;
        if (p.assets !== undefined) body.assets = p.assets;
        const r = await ctx.sdk.createRelease(p.namespace, p.project, body);
        throwIfHttpError(r);
        return r.data;
      },
    },

    update_release: {
      description: "Update a GitLab release's name, description, or milestones",
      params: updateReleaseParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          name?: string;
          description?: string;
          milestones?: string[];
        } = {};
        if (p.name !== undefined) body.name = p.name;
        if (p.description !== undefined) body.description = p.description;
        if (p.milestones !== undefined) body.milestones = p.milestones;
        const r = await ctx.sdk.updateRelease(p.namespace, p.project, p.tag_name, body);
        throwIfHttpError(r);
        return r.data;
      },
    },

    delete_release: {
      description: "Delete a GitLab release (does not delete the underlying git tag)",
      params: deleteReleaseParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deleteRelease(p.namespace, p.project, p.tag_name);
        throwIfHttpError(r);
        return { tag_name: p.tag_name, deleted: true };
      },
    },

    delete_release_link: {
      description: "Delete an asset link from a GitLab release",
      params: deleteReleaseLinkParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deleteReleaseLink(
          p.namespace,
          p.project,
          p.tag_name,
          p.link_id,
        );
        throwIfHttpError(r);
        return { link_id: p.link_id, deleted: true };
      },
    },
  };
}
