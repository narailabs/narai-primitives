/**
 * Tests for actions/pulls.ts — schema validation, classification,
 * handler envelope shape, and the require_draft_pr enforcement path.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildPullsActions } from "../../../../src/connectors/github/actions/pulls.js";
import type { GithubClient } from "../../../../src/connectors/github/lib/github_client.js";

function fakeSdk(overrides: Partial<GithubClient> = {}): GithubClient {
  return overrides as unknown as GithubClient;
}

function runHandler<P>(
  spec: ActionSpec<P, GithubClient>,
  params: unknown,
  sdk: GithubClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

describe("buildPullsActions — classification", () => {
  const actions = buildPullsActions({ behavior: { requireDraftPr: false } });

  it("get_pull_request is read", () => {
    expect(actions["get_pull_request"]?.classify).toEqual({ kind: "read" });
  });
  it("create_pull_request is write", () => {
    expect(actions["create_pull_request"]?.classify).toEqual({ kind: "write" });
  });
  it("update_pull_request is write", () => {
    expect(actions["update_pull_request"]?.classify).toEqual({ kind: "write" });
  });
  it("close_pull_request is write + delete aspect", () => {
    expect(actions["close_pull_request"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
  it("merge_pull_request is admin", () => {
    expect(actions["merge_pull_request"]?.classify).toEqual({ kind: "admin" });
  });
});

describe("get_pull_request", () => {
  it("fetches and maps a PR by number", async () => {
    const sdk = fakeSdk({
      getPull: async () => ({
        ok: true,
        status: 200,
        data: {
          number: 42,
          title: "feat: x",
          state: "open",
          draft: false,
          user: { login: "alice" },
          base: { ref: "main", sha: "b0" },
          head: { ref: "feat/x", sha: "h0" },
          html_url: "https://github.com/o/r/pull/42",
          merged: false,
          mergeable: true,
          updated_at: "2026-05-01T00:00:00Z",
          body: "hello",
        },
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = await runHandler(
      actions["get_pull_request"]!,
      { owner: "o", repo: "r", pull_number: 42 },
      sdk,
    );
    expect(r).toMatchObject({
      number: 42,
      title: "feat: x",
      state: "open",
      draft: false,
      author: "alice",
      base_ref: "main",
      head_ref: "feat/x",
    });
  });
});

describe("create_pull_request — require_draft_pr enforcement", () => {
  it("forwards caller draft when require_draft_pr is false", async () => {
    let bodySent: Record<string, unknown> | null = null;
    const sdk = fakeSdk({
      createPull: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            number: 7,
            title: "t",
            state: "open",
            draft: false,
            html_url: "https://github.com/o/r/pull/7",
          },
        };
      },
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      actions["create_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        head: "feat/x",
        base: "main",
        draft: false,
      },
      sdk,
    )) as { draft_forced_by_config: boolean };
    expect(bodySent?.["draft"]).toBe(false);
    expect(r.draft_forced_by_config).toBe(false);
  });

  it("forces draft when require_draft_pr is true and caller asked for non-draft", async () => {
    let bodySent: Record<string, unknown> | null = null;
    const sdk = fakeSdk({
      createPull: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            number: 7,
            title: "t",
            state: "open",
            draft: true,
            html_url: "https://github.com/o/r/pull/7",
          },
        };
      },
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: true } });
    const r = (await runHandler(
      actions["create_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        head: "feat/x",
        base: "main",
        draft: false,
      },
      sdk,
    )) as { draft: boolean; draft_forced_by_config: boolean };
    expect(bodySent?.["draft"]).toBe(true);
    expect(r.draft).toBe(true);
    expect(r.draft_forced_by_config).toBe(true);
  });

  it("does not flag draft_forced_by_config when caller already asked for draft", async () => {
    const sdk = fakeSdk({
      createPull: async () => ({
        ok: true,
        status: 201,
        data: {
          number: 7,
          title: "t",
          state: "open",
          draft: true,
          html_url: "x",
        },
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: true } });
    const r = (await runHandler(
      actions["create_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        head: "feat/x",
        base: "main",
        draft: true,
      },
      sdk,
    )) as { draft_forced_by_config: boolean };
    expect(r.draft_forced_by_config).toBe(false);
  });
});

describe("update_pull_request — schema rejects state=closed", () => {
  const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
  it("accepts state=open", () => {
    expect(() =>
      actions["update_pull_request"]!.params.parse({
        owner: "o",
        repo: "r",
        pull_number: 1,
        state: "open",
      }),
    ).not.toThrow();
  });
  it("rejects state=closed (use close_pull_request)", () => {
    expect(() =>
      actions["update_pull_request"]!.params.parse({
        owner: "o",
        repo: "r",
        pull_number: 1,
        state: "closed",
      }),
    ).toThrow(/close_pull_request/);
  });
});

describe("close_pull_request", () => {
  it("calls closePull and returns a closed envelope", async () => {
    let called = false;
    const sdk = fakeSdk({
      closePull: async (o, r, n) => {
        called = true;
        return {
          ok: true,
          status: 200,
          data: { number: n, state: "closed", html_url: `https://x/${o}/${r}/${n}` },
        };
      },
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      actions["close_pull_request"]!,
      { owner: "o", repo: "r", pull_number: 9 },
      sdk,
    )) as { number: number; state: string; closed: boolean };
    expect(called).toBe(true);
    expect(r).toMatchObject({ number: 9, state: "closed", closed: true });
  });
});

describe("merge_pull_request", () => {
  it("returns a merged envelope on 200", async () => {
    const sdk = fakeSdk({
      mergePull: async () => ({
        ok: true,
        status: 200,
        data: { sha: "abc123", merged: true, message: "Pull Request successfully merged" },
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      actions["merge_pull_request"]!,
      {
        owner: "o",
        repo: "r",
        pull_number: 3,
        merge_method: "squash",
      },
      sdk,
    )) as { merged: boolean; merge_sha: string };
    expect(r).toMatchObject({ merged: true, merge_sha: "abc123" });
  });

  it("translates 409 conflict to VALIDATION_ERROR", async () => {
    const sdk = fakeSdk({
      mergePull: async () => ({
        ok: false,
        code: "HTTP_ERROR",
        status: 409,
        message: "Head branch was modified",
        retriable: false,
      }),
    });
    const actions = buildPullsActions({ behavior: { requireDraftPr: false } });
    await expect(
      runHandler(
        actions["merge_pull_request"]!,
        {
          owner: "o",
          repo: "r",
          pull_number: 3,
          merge_method: "merge",
        },
        sdk,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
