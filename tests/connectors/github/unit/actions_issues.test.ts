import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildIssuesActions } from "../../../../src/connectors/github/actions/issues.js";
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

describe("buildIssuesActions — classification", () => {
  const actions = buildIssuesActions({ behavior: { requireDraftPr: false } });
  it("get_issue is read", () => {
    expect(actions["get_issue"]?.classify).toEqual({ kind: "read" });
  });
  it("create_issue is write", () => {
    expect(actions["create_issue"]?.classify).toEqual({ kind: "write" });
  });
  it("update_issue is write", () => {
    expect(actions["update_issue"]?.classify).toEqual({ kind: "write" });
  });
  it("close_issue is write + delete aspect", () => {
    expect(actions["close_issue"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

describe("get_issue", () => {
  it("maps to a normalized envelope", async () => {
    const sdk = fakeSdk({
      getIssue: async () => ({
        ok: true,
        status: 200,
        data: {
          number: 11,
          title: "bug: x",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: "bug" }, "p1"],
          html_url: "https://github.com/o/r/issues/11",
          body: "...",
          updated_at: "2026-05-01T00:00:00Z",
        },
      }),
    });
    const actions = buildIssuesActions({
      behavior: { requireDraftPr: false },
    });
    const r = (await runHandler(
      actions["get_issue"]!,
      { owner: "o", repo: "r", issue_number: 11 },
      sdk,
    )) as { number: number; author: string; labels: string[] };
    expect(r).toMatchObject({
      number: 11,
      author: "alice",
      labels: ["bug", "p1"],
    });
  });
});

describe("create_issue", () => {
  it("forwards title/body/labels/assignees", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createIssue: async (_o, _r, body) => {
        bodySent = body;
        return {
          ok: true,
          status: 201,
          data: {
            number: 12,
            title: "t",
            state: "open",
            html_url: "x",
            user: { login: "alice" },
          },
        };
      },
    });
    const actions = buildIssuesActions({
      behavior: { requireDraftPr: false },
    });
    const r = (await runHandler(
      actions["create_issue"]!,
      {
        owner: "o",
        repo: "r",
        title: "t",
        body: "b",
        labels: ["bug"],
        assignees: ["alice"],
      },
      sdk,
    )) as { number: number };
    expect(r.number).toBe(12);
    expect(bodySent).toMatchObject({
      title: "t",
      body: "b",
      labels: ["bug"],
      assignees: ["alice"],
    });
  });
});

describe("update_issue — schema rejects state=closed", () => {
  const actions = buildIssuesActions({ behavior: { requireDraftPr: false } });
  it("accepts state=open", () => {
    expect(() =>
      actions["update_issue"]!.params.parse({
        owner: "o",
        repo: "r",
        issue_number: 1,
        state: "open",
      }),
    ).not.toThrow();
  });
  it("rejects state=closed", () => {
    expect(() =>
      actions["update_issue"]!.params.parse({
        owner: "o",
        repo: "r",
        issue_number: 1,
        state: "closed",
      }),
    ).toThrow(/close_issue/);
  });
});

describe("close_issue", () => {
  it("returns closed envelope and accepts state_reason", async () => {
    let bodySent: Record<string, unknown> = {};
    const sdk = fakeSdk({
      closeIssue: async (_o, _r, _n, body) => {
        bodySent = body ?? {};
        return {
          ok: true,
          status: 200,
          data: {
            number: 11,
            title: "t",
            state: "closed",
            html_url: "x",
            user: { login: "alice" },
          },
        };
      },
    });
    const actions = buildIssuesActions({
      behavior: { requireDraftPr: false },
    });
    const r = (await runHandler(
      actions["close_issue"]!,
      {
        owner: "o",
        repo: "r",
        issue_number: 11,
        state_reason: "completed",
      },
      sdk,
    )) as { closed: boolean; state: string };
    expect(r).toMatchObject({ closed: true, state: "closed" });
    expect(bodySent["state_reason"]).toBe("completed");
  });
});
