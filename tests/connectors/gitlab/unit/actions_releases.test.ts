/**
 * Tests for gitlab/actions/releases.ts — classification, schemas, and handlers
 * for create_release, update_release, delete_release, and delete_release_link.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildReleasesActions } from "../../../../src/connectors/gitlab/actions/releases.js";
import type { GitlabClient } from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

function fakeSdk(overrides: Partial<GitlabClient> = {}): GitlabClient {
  return overrides as unknown as GitlabClient;
}

function runHandler<P>(
  spec: ActionSpec<P, GitlabClient>,
  params: unknown,
  sdk: GitlabClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

const baseDeps = {
  behavior: { requireDraftMr: false, host: "https://gitlab.com" },
};

const releaseResponse = {
  tag_name: "v1.0.0",
  name: "Version 1.0.0",
  description: "First release",
  created_at: "2024-01-01T00:00:00Z",
  released_at: "2024-01-01T00:00:00Z",
};

// ── Classification ────────────────────────────────────────────────────────────

describe("buildReleasesActions — classification", () => {
  const actions = buildReleasesActions(baseDeps);

  it("create_release is write", () => {
    expect(actions["create_release"]?.classify).toEqual({ kind: "write" });
  });

  it("update_release is write", () => {
    expect(actions["update_release"]?.classify).toEqual({ kind: "write" });
  });

  it("delete_release is write + delete aspect", () => {
    expect(actions["delete_release"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });

  it("delete_release_link is write + delete aspect", () => {
    expect(actions["delete_release_link"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

// ── create_release ────────────────────────────────────────────────────────────

describe("create_release", () => {
  it("creates release with required fields and returns data", async () => {
    let captured: unknown;
    const sdk = fakeSdk({
      createRelease: async (_ns, _proj, body) => {
        captured = body;
        return { ok: true as const, status: 201, data: { ...releaseResponse } };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    const result = (await runHandler(
      actions["create_release"]!,
      { namespace: "mygroup", project: "myproject", tag_name: "v1.0.0", name: "Version 1.0.0" },
      sdk,
    )) as Record<string, unknown>;

    expect(result["tag_name"]).toBe("v1.0.0");
    expect(result["name"]).toBe("Version 1.0.0");
    expect((captured as Record<string, unknown>)["tag_name"]).toBe("v1.0.0");
    expect((captured as Record<string, unknown>)["name"]).toBe("Version 1.0.0");
  });

  it("passes optional description, ref, and assets.links", async () => {
    let captured: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createRelease: async (_ns, _proj, body) => {
        captured = body as Record<string, unknown>;
        return { ok: true as const, status: 201, data: { ...releaseResponse } };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    await runHandler(
      actions["create_release"]!,
      {
        namespace: "g",
        project: "p",
        tag_name: "v1.0.0",
        name: "Release",
        description: "Desc",
        ref: "main",
        assets: {
          links: [{ name: "binary", url: "https://example.com/bin", link_type: "package" }],
        },
      },
      sdk,
    );

    expect(captured["description"]).toBe("Desc");
    expect(captured["ref"]).toBe("main");
    expect((captured["assets"] as Record<string, unknown>)["links"]).toHaveLength(1);
  });

  it("schema rejects missing name", () => {
    const actions = buildReleasesActions(baseDeps);
    expect(() =>
      actions["create_release"]!.params.parse({
        namespace: "g",
        project: "p",
        tag_name: "v1.0.0",
      }),
    ).toThrow();
  });

  it("schema rejects invalid tag_name", () => {
    const actions = buildReleasesActions(baseDeps);
    expect(() =>
      actions["create_release"]!.params.parse({
        namespace: "g",
        project: "p",
        tag_name: "bad tag!",
        name: "Release",
      }),
    ).toThrow();
  });

  it("schema rejects asset link with invalid URL", () => {
    const actions = buildReleasesActions(baseDeps);
    expect(() =>
      actions["create_release"]!.params.parse({
        namespace: "g",
        project: "p",
        tag_name: "v1.0.0",
        name: "Release",
        assets: { links: [{ name: "bin", url: "not-a-url" }] },
      }),
    ).toThrow();
  });

  it("omits undefined optional fields from body", async () => {
    let captured: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createRelease: async (_ns, _proj, body) => {
        captured = body as Record<string, unknown>;
        return { ok: true as const, status: 201, data: { ...releaseResponse } };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    await runHandler(
      actions["create_release"]!,
      { namespace: "g", project: "p", tag_name: "v1.0.0", name: "Release" },
      sdk,
    );

    expect(captured["description"]).toBeUndefined();
    expect(captured["ref"]).toBeUndefined();
    expect(captured["assets"]).toBeUndefined();
  });
});

// ── update_release ────────────────────────────────────────────────────────────

describe("update_release", () => {
  it("updates name and description, returns data", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      updateRelease: async (_ns, _proj, _tag, body) => {
        capturedBody = body as Record<string, unknown>;
        return {
          ok: true as const,
          status: 200,
          data: { ...releaseResponse, name: "Updated" },
        };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    const result = (await runHandler(
      actions["update_release"]!,
      {
        namespace: "g",
        project: "p",
        tag_name: "v1.0.0",
        name: "Updated",
        description: "New desc",
      },
      sdk,
    )) as Record<string, unknown>;

    expect(result["name"]).toBe("Updated");
    expect(capturedBody["name"]).toBe("Updated");
    expect(capturedBody["description"]).toBe("New desc");
  });

  it("passes milestones", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      updateRelease: async (_ns, _proj, _tag, body) => {
        capturedBody = body as Record<string, unknown>;
        return { ok: true as const, status: 200, data: { ...releaseResponse } };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    await runHandler(
      actions["update_release"]!,
      { namespace: "g", project: "p", tag_name: "v1.0.0", milestones: ["14.9"] },
      sdk,
    );
    expect(capturedBody["milestones"]).toEqual(["14.9"]);
  });

  it("omits undefined optional fields from body", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      updateRelease: async (_ns, _proj, _tag, body) => {
        capturedBody = body as Record<string, unknown>;
        return { ok: true as const, status: 200, data: { ...releaseResponse } };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    await runHandler(
      actions["update_release"]!,
      { namespace: "g", project: "p", tag_name: "v1.0.0", name: "Only name" },
      sdk,
    );
    expect(capturedBody["description"]).toBeUndefined();
    expect(capturedBody["milestones"]).toBeUndefined();
  });
});

// ── delete_release ────────────────────────────────────────────────────────────

describe("delete_release", () => {
  it("calls deleteRelease and returns { tag_name, deleted: true }", async () => {
    let calledWith: { ns: string; proj: string; tag: string } | null = null;
    const sdk = fakeSdk({
      deleteRelease: async (ns, proj, tag) => {
        calledWith = { ns, proj, tag };
        return { ok: true as const, status: 204, data: null };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    const result = (await runHandler(
      actions["delete_release"]!,
      { namespace: "mygroup", project: "myproject", tag_name: "v1.0.0" },
      sdk,
    )) as Record<string, unknown>;

    expect(result["tag_name"]).toBe("v1.0.0");
    expect(result["deleted"]).toBe(true);
    expect(calledWith).toEqual({ ns: "mygroup", proj: "myproject", tag: "v1.0.0" });
  });

  it("schema rejects missing tag_name", () => {
    const actions = buildReleasesActions(baseDeps);
    expect(() =>
      actions["delete_release"]!.params.parse({ namespace: "g", project: "p" }),
    ).toThrow();
  });
});

// ── delete_release_link ───────────────────────────────────────────────────────

describe("delete_release_link", () => {
  it("calls deleteReleaseLink and returns { link_id, deleted: true }", async () => {
    let calledWith: { ns: string; proj: string; tag: string; linkId: number } | null = null;
    const sdk = fakeSdk({
      deleteReleaseLink: async (ns, proj, tag, linkId) => {
        calledWith = { ns, proj, tag, linkId };
        return { ok: true as const, status: 204, data: null };
      },
    });
    const actions = buildReleasesActions(baseDeps);
    const result = (await runHandler(
      actions["delete_release_link"]!,
      { namespace: "mygroup", project: "myproject", tag_name: "v1.0.0", link_id: 42 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["link_id"]).toBe(42);
    expect(result["deleted"]).toBe(true);
    expect(calledWith).toEqual({
      ns: "mygroup",
      proj: "myproject",
      tag: "v1.0.0",
      linkId: 42,
    });
  });

  it("schema rejects missing link_id", () => {
    const actions = buildReleasesActions(baseDeps);
    expect(() =>
      actions["delete_release_link"]!.params.parse({
        namespace: "g",
        project: "p",
        tag_name: "v1.0.0",
      }),
    ).toThrow();
  });

  it("schema rejects non-positive link_id", () => {
    const actions = buildReleasesActions(baseDeps);
    expect(() =>
      actions["delete_release_link"]!.params.parse({
        namespace: "g",
        project: "p",
        tag_name: "v1.0.0",
        link_id: 0,
      }),
    ).toThrow();
  });
});
