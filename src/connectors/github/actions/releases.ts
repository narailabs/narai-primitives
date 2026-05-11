/**
 * Release actions: create / update / delete + delete_release_asset.
 * Asset upload (multipart to uploads.github.com) is intentionally out of
 * scope — see spec §2 "Non-goals".
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";
import type { GithubReleaseDetail } from "../lib/github_client.js";
import { ownerRepoField, tagField } from "./_fields.js";

const idField = z.coerce.number().int().positive();

const createReleaseParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  tag_name: tagField,
  name: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  target_commitish: z.string().optional(),
  make_latest: z.enum(["true", "false", "legacy"]).optional(),
});

const updateReleaseParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  release_id: idField,
  tag_name: tagField.optional(),
  name: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  target_commitish: z.string().optional(),
});

const deleteReleaseParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  release_id: idField,
});

const deleteAssetParams = z.object({
  owner: ownerRepoField,
  repo: ownerRepoField,
  asset_id: idField,
});

function releaseEnvelope(d: GithubReleaseDetail) {
  return {
    release_id: d.id,
    tag_name: d.tag_name,
    name: d.name ?? "",
    body_markdown: d.body ?? "",
    draft: d.draft ?? false,
    prerelease: d.prerelease ?? false,
    url: d.html_url ?? "",
    published_at: d.published_at ?? null,
  };
}

export function buildReleasesActions(_deps: GithubActionDeps): GithubActions {
  return {
    create_release: {
      description: "Create a release (optionally draft)",
      params: createReleaseParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          tag_name: string;
          name?: string;
          body?: string;
          draft?: boolean;
          prerelease?: boolean;
          target_commitish?: string;
          make_latest?: "true" | "false" | "legacy";
        } = {
          tag_name: p.tag_name,
          draft: p.draft,
          prerelease: p.prerelease,
        };
        if (p.name !== undefined) body.name = p.name;
        if (p.body !== undefined) body.body = p.body;
        if (p.target_commitish !== undefined)
          body.target_commitish = p.target_commitish;
        if (p.make_latest !== undefined) body.make_latest = p.make_latest;
        const r = await ctx.sdk.createRelease(p.owner, p.repo, body);
        throwIfHttpError(r);
        return releaseEnvelope(r.data);
      },
    },
    update_release: {
      description: "Update a release's title, body, draft/prerelease flag, or tag",
      params: updateReleaseParams,
      classify: { kind: "write" },
      handler: async (p, ctx) => {
        const body: {
          tag_name?: string;
          name?: string;
          body?: string;
          draft?: boolean;
          prerelease?: boolean;
          target_commitish?: string;
        } = {};
        if (p.tag_name !== undefined) body.tag_name = p.tag_name;
        if (p.name !== undefined) body.name = p.name;
        if (p.body !== undefined) body.body = p.body;
        if (p.draft !== undefined) body.draft = p.draft;
        if (p.prerelease !== undefined) body.prerelease = p.prerelease;
        if (p.target_commitish !== undefined)
          body.target_commitish = p.target_commitish;
        const r = await ctx.sdk.updateRelease(
          p.owner,
          p.repo,
          p.release_id,
          body,
        );
        throwIfHttpError(r);
        return releaseEnvelope(r.data);
      },
    },
    delete_release: {
      description:
        "Delete a release (does not delete the underlying git tag)",
      params: deleteReleaseParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deleteRelease(p.owner, p.repo, p.release_id);
        throwIfHttpError(r);
        return { release_id: p.release_id, deleted: true };
      },
    },
    delete_release_asset: {
      description: "Delete a single release asset by id",
      params: deleteAssetParams,
      classify: { kind: "write", aspects: ["delete"] },
      handler: async (p, ctx) => {
        const r = await ctx.sdk.deleteReleaseAsset(
          p.owner,
          p.repo,
          p.asset_id,
        );
        throwIfHttpError(r);
        return { asset_id: p.asset_id, deleted: true };
      },
    },
  };
}
