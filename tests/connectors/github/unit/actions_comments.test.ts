import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildCommentsActions } from "../../../../src/connectors/github/actions/comments.js";
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

describe("buildCommentsActions — classification", () => {
  const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
  it("add_issue_comment is write", () => {
    expect(a["add_issue_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("update_issue_comment is write", () => {
    expect(a["update_issue_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("delete_issue_comment is write + delete aspect", () => {
    expect(a["delete_issue_comment"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
  it("add_pr_review_comment is write", () => {
    expect(a["add_pr_review_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("update_pr_review_comment is write", () => {
    expect(a["update_pr_review_comment"]?.classify).toEqual({ kind: "write" });
  });
  it("delete_pr_review_comment is write + delete aspect", () => {
    expect(a["delete_pr_review_comment"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

describe("add_issue_comment", () => {
  it("posts the body and returns envelope", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      addIssueComment: async (_o, _r, _n, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            id: 99,
            user: { login: "alice" },
            body: "hello",
            html_url: "x",
            created_at: "2026-05-01T00:00:00Z",
          },
        };
      },
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["add_issue_comment"]!,
      { owner: "o", repo: "r", issue_number: 1, body: "hello" },
      sdk,
    )) as { comment_id: number; body_markdown: string };
    expect(bodySent["body"]).toBe("hello");
    expect(r).toMatchObject({ comment_id: 99, body_markdown: "hello" });
  });
});

describe("update_issue_comment", () => {
  it("patches the comment by id", async () => {
    const sdk = fakeSdk({
      updateIssueComment: async (_o, _r, _id, body) => ({
        ok: true,
        status: 200,
        data: {
          id: 99,
          user: { login: "alice" },
          body: body.body,
          html_url: "x",
          created_at: "x",
          updated_at: "y",
        },
      }),
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["update_issue_comment"]!,
      { owner: "o", repo: "r", comment_id: 99, body: "edited" },
      sdk,
    )) as { body_markdown: string };
    expect(r.body_markdown).toBe("edited");
  });
});

describe("delete_issue_comment", () => {
  it("returns { deleted: true } on 204", async () => {
    let called = false;
    const sdk = fakeSdk({
      deleteIssueComment: async () => {
        called = true;
        return { ok: true, status: 204, data: undefined as unknown };
      },
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["delete_issue_comment"]!,
      { owner: "o", repo: "r", comment_id: 99 },
      sdk,
    )) as { comment_id: number; deleted: boolean };
    expect(called).toBe(true);
    expect(r).toMatchObject({ comment_id: 99, deleted: true });
  });
});

describe("add_pr_review_comment", () => {
  it("requires commit_id, path, line in schema", () => {
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    expect(() =>
      a["add_pr_review_comment"]!.params.parse({
        owner: "o",
        repo: "r",
        pr_number: 1,
        body: "x",
        commit_id: "deadbeef",
        path: "src/x.ts",
        line: 10,
      }),
    ).not.toThrow();
    expect(() =>
      a["add_pr_review_comment"]!.params.parse({
        owner: "o",
        repo: "r",
        pr_number: 1,
        body: "x",
      }),
    ).toThrow();
  });
});

describe("delete_pr_review_comment", () => {
  it("returns { deleted: true } on 204", async () => {
    const sdk = fakeSdk({
      deletePrReviewComment: async () => ({
        ok: true,
        status: 204,
        data: undefined as unknown,
      }),
    });
    const a = buildCommentsActions({ behavior: { requireDraftPr: false } });
    const r = (await runHandler(
      a["delete_pr_review_comment"]!,
      { owner: "o", repo: "r", comment_id: 12 },
      sdk,
    )) as { deleted: boolean };
    expect(r.deleted).toBe(true);
  });
});
