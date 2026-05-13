/**
 * Tests for gitlab/actions/merges.ts — classification, schemas,
 * require_draft_mr enforcement, and conflict handling.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildMergesActions } from "../../../../src/connectors/gitlab/actions/merges.js";
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

const draftDeps = {
  behavior: { requireDraftMr: true, host: "https://gitlab.com" },
};

const mrResponse = {
  iid: 42,
  title: "My MR",
  state: "opened",
  draft: false,
  source_branch: "feat",
  target_branch: "main",
  sha: "abc1234",
  description: "desc",
  web_url: "https://gitlab.com/g/p/-/merge_requests/42",
  updated_at: "2024-01-01T00:00:00Z",
  author: { username: "alice" },
};

// ── Classification ────────────────────────────────────────────────────────────

describe("buildMergesActions — classification", () => {
  const actions = buildMergesActions(baseDeps);

  it("create_merge_request is write", () => {
    expect(actions["create_merge_request"]?.classify).toEqual({ kind: "write" });
  });

  it("update_merge_request is write", () => {
    expect(actions["update_merge_request"]?.classify).toEqual({ kind: "write" });
  });

  it("close_merge_request is write + delete aspect", () => {
    expect(actions["close_merge_request"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });

  it("merge_merge_request is admin", () => {
    expect(actions["merge_merge_request"]?.classify).toEqual({ kind: "admin" });
  });
});

// ── create_merge_request ──────────────────────────────────────────────────────

describe("create_merge_request", () => {
  it("creates MR with required fields", async () => {
    let captured: unknown;
    const sdk = fakeSdk({
      createMergeRequest: async (_ns, _proj, body) => {
        captured = body;
        return { ok: true as const, status: 201, data: { ...mrResponse } };
      },
    });
    const actions = buildMergesActions(baseDeps);
    const result = await runHandler(
      actions["create_merge_request"]!,
      {
        namespace: "mygroup",
        project: "myproject",
        source_branch: "feat",
        target_branch: "main",
        title: "My MR",
      },
      sdk,
    );
    expect(result).toMatchObject({ iid: 42, title: "My MR", state: "opened" });
    expect((captured as Record<string, unknown>)["draft"]).toBe(false);
  });

  it("does not set draft_forced_by_config when draft not requested and requireDraftMr=false", async () => {
    const sdk = fakeSdk({
      createMergeRequest: async () => ({
        ok: true as const,
        status: 201,
        data: { ...mrResponse },
      }),
    });
    const actions = buildMergesActions(baseDeps);
    const result = (await runHandler(
      actions["create_merge_request"]!,
      {
        namespace: "g",
        project: "p",
        source_branch: "feat",
        target_branch: "main",
        title: "T",
      },
      sdk,
    )) as Record<string, unknown>;
    expect(result["draft_forced_by_config"]).toBeUndefined();
  });

  it("forces draft=true and returns draft_forced_by_config when requireDraftMr=true and caller sent draft=false", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createMergeRequest: async (_ns, _proj, body) => {
        capturedBody = body as Record<string, unknown>;
        return {
          ok: true as const,
          status: 201,
          data: { ...mrResponse, draft: true },
        };
      },
    });
    const actions = buildMergesActions(draftDeps);
    const result = (await runHandler(
      actions["create_merge_request"]!,
      {
        namespace: "g",
        project: "p",
        source_branch: "feat",
        target_branch: "main",
        title: "T",
        draft: false,
      },
      sdk,
    )) as Record<string, unknown>;
    expect(capturedBody["draft"]).toBe(true);
    expect(result["draft_forced_by_config"]).toBe(true);
  });

  it("does NOT set draft_forced_by_config when caller already requested draft=true and requireDraftMr=true", async () => {
    const sdk = fakeSdk({
      createMergeRequest: async () => ({
        ok: true as const,
        status: 201,
        data: { ...mrResponse, draft: true },
      }),
    });
    const actions = buildMergesActions(draftDeps);
    const result = (await runHandler(
      actions["create_merge_request"]!,
      {
        namespace: "g",
        project: "p",
        source_branch: "feat",
        target_branch: "main",
        title: "T",
        draft: true,
      },
      sdk,
    )) as Record<string, unknown>;
    expect(result["draft_forced_by_config"]).toBeUndefined();
  });

  it("schema rejects empty title", () => {
    const actions = buildMergesActions(baseDeps);
    expect(() =>
      actions["create_merge_request"]!.params.parse({
        namespace: "g",
        project: "p",
        source_branch: "feat",
        target_branch: "main",
        title: "",
      }),
    ).toThrow();
  });
});

// ── update_merge_request ──────────────────────────────────────────────────────

describe("update_merge_request", () => {
  it("updates title and description", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      updateMergeRequest: async (_ns, _proj, _iid, body) => {
        capturedBody = body as Record<string, unknown>;
        return { ok: true as const, status: 200, data: { ...mrResponse, title: "New title" } };
      },
    });
    const actions = buildMergesActions(baseDeps);
    const result = (await runHandler(
      actions["update_merge_request"]!,
      {
        namespace: "g",
        project: "p",
        mr_iid: 42,
        title: "New title",
        description: "Updated",
      },
      sdk,
    )) as Record<string, unknown>;
    expect(result["title"]).toBe("New title");
    expect(capturedBody["title"]).toBe("New title");
    expect(capturedBody["description"]).toBe("Updated");
  });

  it("schema rejects state_event=close", () => {
    const actions = buildMergesActions(baseDeps);
    expect(() =>
      actions["update_merge_request"]!.params.parse({
        namespace: "g",
        project: "p",
        mr_iid: 1,
        state_event: "close",
      }),
    ).toThrow();
  });

  it("schema allows state_event=reopen", () => {
    const actions = buildMergesActions(baseDeps);
    expect(() =>
      actions["update_merge_request"]!.params.parse({
        namespace: "g",
        project: "p",
        mr_iid: 1,
        state_event: "reopen",
      }),
    ).not.toThrow();
  });
});

// ── close_merge_request ───────────────────────────────────────────────────────

describe("close_merge_request", () => {
  it("calls closeMergeRequest and returns closed:true", async () => {
    const sdk = fakeSdk({
      closeMergeRequest: async () => ({
        ok: true as const,
        status: 200,
        data: { ...mrResponse, state: "closed" },
      }),
    });
    const actions = buildMergesActions(baseDeps);
    const result = (await runHandler(
      actions["close_merge_request"]!,
      { namespace: "g", project: "p", mr_iid: 42 },
      sdk,
    )) as Record<string, unknown>;
    expect(result["closed"]).toBe(true);
    expect(result["state"]).toBe("closed");
  });
});

// ── merge_merge_request ───────────────────────────────────────────────────────

describe("merge_merge_request", () => {
  it("returns merge result on 200", async () => {
    const sdk = fakeSdk({
      mergeMergeRequest: async () => ({
        ok: true as const,
        status: 200,
        data: { sha: "deadbeef", merged: true, message: "merged" },
      }),
    });
    const actions = buildMergesActions(baseDeps);
    const result = (await runHandler(
      actions["merge_merge_request"]!,
      { namespace: "g", project: "p", mr_iid: 42 },
      sdk,
    )) as Record<string, unknown>;
    expect(result["merged"]).toBe(true);
    expect(result["merge_sha"]).toBe("deadbeef");
  });

  it("throws CONFLICT on 405", async () => {
    const sdk = fakeSdk({
      mergeMergeRequest: async () => ({
        ok: false as const,
        status: 405,
        code: "HTTP_ERROR" as const,
        message: "Not Allowed",
        retriable: false,
      }),
    });
    const actions = buildMergesActions(baseDeps);
    await expect(
      runHandler(
        actions["merge_merge_request"]!,
        { namespace: "g", project: "p", mr_iid: 42 },
        sdk,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("throws CONFLICT on 406", async () => {
    const sdk = fakeSdk({
      mergeMergeRequest: async () => ({
        ok: false as const,
        status: 406,
        code: "HTTP_ERROR" as const,
        message: "Not Acceptable",
        retriable: false,
      }),
    });
    const actions = buildMergesActions(baseDeps);
    await expect(
      runHandler(
        actions["merge_merge_request"]!,
        { namespace: "g", project: "p", mr_iid: 42 },
        sdk,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("throws CONFLICT on 409", async () => {
    const sdk = fakeSdk({
      mergeMergeRequest: async () => ({
        ok: false as const,
        status: 409,
        code: "HTTP_ERROR" as const,
        message: "Conflict",
        retriable: false,
      }),
    });
    const actions = buildMergesActions(baseDeps);
    await expect(
      runHandler(
        actions["merge_merge_request"]!,
        { namespace: "g", project: "p", mr_iid: 42 },
        sdk,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
