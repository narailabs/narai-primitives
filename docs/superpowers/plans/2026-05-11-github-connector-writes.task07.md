# Task 7: Release actions module (`actions/releases.ts`)

Add 4 client methods and 4 action specs covering `create_release`, `update_release`, `delete_release` (write + delete aspect), and `delete_release_asset` (write + delete aspect).

**Files:**
- Modify: `src/connectors/github/lib/github_client.ts` (add 4 methods + `GithubReleaseDetail` type)
- Create: `src/connectors/github/actions/releases.ts`
- Modify: `src/connectors/github/index.ts` (spread `buildReleasesActions`)
- Create: `tests/connectors/github/unit/actions_releases.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/connectors/github/unit/actions_releases.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/connectors/github/unit/actions_releases.test.ts
```

- [ ] **Step 3: Add the 4 client methods**

Append to `GithubClient`:

```ts
  // ─── releases (mutations) ───────────────────────────────────────────────
  public async createRelease(
    owner: string,
    repo: string,
    body: {
      tag_name: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
      make_latest?: "true" | "false" | "legacy";
    },
  ): Promise<GithubResult<GithubReleaseDetail>> {
    return this._http.request<GithubReleaseDetail>(
      "POST",
      `/repos/${owner}/${repo}/releases`,
      { body },
    );
  }
  public async updateRelease(
    owner: string,
    repo: string,
    releaseId: number,
    body: {
      tag_name?: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
    },
  ): Promise<GithubResult<GithubReleaseDetail>> {
    return this._http.request<GithubReleaseDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/releases/${releaseId}`,
      { body },
    );
  }
  public async deleteRelease(
    owner: string,
    repo: string,
    releaseId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/releases/${releaseId}`,
    );
  }
  public async deleteReleaseAsset(
    owner: string,
    repo: string,
    assetId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/releases/assets/${assetId}`,
    );
  }
```

Add type:

```ts
export interface GithubReleaseDetail {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string | null;
  target_commitish?: string;
}
```

- [ ] **Step 4: Create `actions/releases.ts`**

```ts
/**
 * Release actions: create / update / delete + delete_release_asset.
 * Asset upload (multipart to uploads.github.com) is intentionally out of
 * scope — see spec §2 "Non-goals".
 */
import { throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import type { GithubActionDeps, GithubActions } from "./_types.js";

const ownerRepoField = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/, "owner/repo: alphanumeric, dots, dashes, underscores only");
const tagField = z.string().min(1).regex(/^[A-Za-z0-9._/+-]+$/, "Invalid tag");
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

function releaseEnvelope(d: {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string | null;
}) {
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
      description: "Delete a release (does not delete the underlying git tag)",
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
```

- [ ] **Step 5: Wire into `index.ts`**

```ts
import { buildReleasesActions } from "./actions/releases.js";
```

```ts
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
      ...buildIssuesActions({ behavior }),
      ...buildCommentsActions({ behavior }),
      ...buildReleasesActions({ behavior }),
    },
```

- [ ] **Step 6: Run tests and append client-method assertions**

```
npx vitest run tests/connectors/github/unit/actions_releases.test.ts
```
Expected: all passing.

Append to `github_client_mutations.test.ts`:

```ts
describe("GithubClient — release methods", () => {
  it("createRelease POSTs to /releases", async () => {
    let observed = { method: "", url: "", body: "" };
    const client = makeClient(async (url, init) => {
      observed = {
        method: String(init?.method ?? ""),
        url,
        body: String(init?.body ?? ""),
      };
      return jsonResponse({ id: 1, tag_name: "v1" });
    });
    const r = await client.createRelease("o", "r", { tag_name: "v1", draft: true });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("POST");
    expect(observed.url).toMatch(/\/repos\/o\/r\/releases$/);
    expect(observed.body).toContain('"draft":true');
  });
  it("updateRelease PATCHes /releases/{id}", async () => {
    let observed = { method: "" };
    const client = makeClient(async (_url, init) => {
      observed = { method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, tag_name: "v1" });
    });
    const r = await client.updateRelease("o", "r", 1, { name: "x" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
  });
  it("deleteRelease DELETEs /releases/{id}", async () => {
    let observed = { method: "", url: "" };
    const client = makeClient(async (url, init) => {
      observed = { method: String(init?.method ?? ""), url };
      return jsonResponse({}, 204);
    });
    const r = await client.deleteRelease("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("DELETE");
    expect(observed.url).toMatch(/\/repos\/o\/r\/releases\/1$/);
  });
  it("deleteReleaseAsset DELETEs /releases/assets/{id}", async () => {
    let observed = { url: "" };
    const client = makeClient(async (url) => {
      observed = { url };
      return jsonResponse({}, 204);
    });
    const r = await client.deleteReleaseAsset("o", "r", 7);
    expect(r.ok).toBe(true);
    expect(observed.url).toMatch(/\/repos\/o\/r\/releases\/assets\/7$/);
  });
});
```

- [ ] **Step 7: Commit**

```
npx vitest run tests/connectors/github && npm run typecheck
```
Expected: all passing.

```
git add src/connectors/github/lib/github_client.ts src/connectors/github/actions/releases.ts src/connectors/github/index.ts tests/connectors/github/unit/actions_releases.test.ts tests/connectors/github/unit/github_client_mutations.test.ts
git commit -m "feat(github): release actions (create/update/delete + delete_asset)

Adds 4 release-management actions. Asset upload is intentionally out
of scope (multipart on uploads.github.com — see spec non-goals). Both
delete actions carry aspects: [\"delete\"]."
```
