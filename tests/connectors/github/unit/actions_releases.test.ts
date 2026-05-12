import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildReleasesActions } from "../../../../src/connectors/github/actions/releases.js";
import type { GithubClient } from "../../../../src/connectors/github/lib/github_client.js";

function fakeSdk(o: Partial<GithubClient> = {}): GithubClient {
  return o as unknown as GithubClient;
}
function runHandler<P>(
  spec: ActionSpec<P, GithubClient>,
  params: unknown,
  sdk: GithubClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

describe("buildReleasesActions — classification", () => {
  const a = buildReleasesActions({ behavior: { requireDraftPr: false } });
  it("create_release is write", () => {
    expect(a["create_release"]?.classify).toEqual({ kind: "write" });
  });
  it("update_release is write", () => {
    expect(a["update_release"]?.classify).toEqual({ kind: "write" });
  });
  it("delete_release is write + delete aspect", () => {
    expect(a["delete_release"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
  it("delete_release_asset is write + delete aspect", () => {
    expect(a["delete_release_asset"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

describe("create_release", () => {
  it("forwards tag/name/body/draft/prerelease/target_commitish", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createRelease: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            id: 500,
            tag_name: "v1.0.0",
            name: "1.0",
            body: "notes",
            draft: true,
            prerelease: false,
            html_url: "x",
            published_at: null,
          },
        };
      },
    });
    const a = buildReleasesActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["create_release"]!,
      {
        owner: "o",
        repo: "r",
        tag_name: "v1.0.0",
        name: "1.0",
        body: "notes",
        draft: true,
        prerelease: false,
        target_commitish: "main",
      },
      sdk,
    )) as { release_id: number; tag_name: string; draft: boolean };
    expect(bodySent).toMatchObject({
      tag_name: "v1.0.0",
      name: "1.0",
      body: "notes",
      draft: true,
      prerelease: false,
      target_commitish: "main",
    });
    expect(r).toMatchObject({ release_id: 500, tag_name: "v1.0.0", draft: true });
  });
});

describe("update_release", () => {
  it("patches the release by id", async () => {
    const sdk = fakeSdk({
      updateRelease: async () => ({
        ok: true,
        status: 200,
        data: {
          id: 500,
          tag_name: "v1.0.0",
          name: "1.0 fixed",
          body: "fixed",
          draft: false,
          prerelease: false,
          html_url: "x",
          published_at: "2026-05-01T00:00:00Z",
        },
      }),
    });
    const a = buildReleasesActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["update_release"]!,
      { owner: "o", repo: "r", release_id: 500, name: "1.0 fixed", draft: false },
      sdk,
    )) as { name: string; draft: boolean };
    expect(r).toMatchObject({ name: "1.0 fixed", draft: false });
  });
});

describe("delete_release", () => {
  it("DELETEs and returns { deleted: true }", async () => {
    let called = false;
    const sdk = fakeSdk({
      deleteRelease: async () => {
        called = true;
        return { ok: true, status: 204, data: undefined as unknown };
      },
    });
    const a = buildReleasesActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["delete_release"]!,
      { owner: "o", repo: "r", release_id: 500 },
      sdk,
    )) as { release_id: number; deleted: boolean };
    expect(called).toBe(true);
    expect(r).toMatchObject({ release_id: 500, deleted: true });
  });
});

describe("delete_release_asset", () => {
  it("DELETEs and returns { deleted: true }", async () => {
    const sdk = fakeSdk({
      deleteReleaseAsset: async () => ({
        ok: true,
        status: 204,
        data: undefined as unknown,
      }),
    });
    const a = buildReleasesActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["delete_release_asset"]!,
      { owner: "o", repo: "r", asset_id: 77 },
      sdk,
    )) as { asset_id: number; deleted: boolean };
    expect(r).toMatchObject({ asset_id: 77, deleted: true });
  });
});
