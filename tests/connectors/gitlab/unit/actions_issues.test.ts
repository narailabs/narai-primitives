/**
 * Tests for gitlab/actions/issues.ts — classification, schemas, and handlers
 * for create_issue, update_issue, and close_issue.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildIssuesActions } from "../../../../src/connectors/gitlab/actions/issues.js";
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

const issueResponse = {
  iid: 7,
  title: "Test issue",
  state: "opened",
  author: { username: "alice" },
  description: "A description",
  labels: ["bug", "v2"],
  web_url: "https://gitlab.com/g/p/-/issues/7",
  updated_at: "2024-01-01T00:00:00Z",
};

// ── Classification ────────────────────────────────────────────────────────────

describe("buildIssuesActions — classification", () => {
  const actions = buildIssuesActions(baseDeps);

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

// ── create_issue ──────────────────────────────────────────────────────────────

describe("create_issue", () => {
  it("creates issue with required title and returns envelope", async () => {
    let captured: unknown;
    const sdk = fakeSdk({
      createIssue: async (_ns, _proj, body) => {
        captured = body;
        return { ok: true as const, status: 201, data: { ...issueResponse } };
      },
    });
    const actions = buildIssuesActions(baseDeps);
    const result = (await runHandler(
      actions["create_issue"]!,
      { namespace: "mygroup", project: "myproject", title: "Test issue" },
      sdk,
    )) as Record<string, unknown>;

    expect(result["iid"]).toBe(7);
    expect(result["title"]).toBe("Test issue");
    expect(result["state"]).toBe("opened");
    expect(result["author"]).toBe("alice");
    expect((captured as Record<string, unknown>)["title"]).toBe("Test issue");
  });

  it("passes optional fields including labels as CSV", async () => {
    let captured: Record<string, unknown> = {};
    const sdk = fakeSdk({
      createIssue: async (_ns, _proj, body) => {
        captured = body as Record<string, unknown>;
        return { ok: true as const, status: 201, data: { ...issueResponse } };
      },
    });
    const actions = buildIssuesActions(baseDeps);
    await runHandler(
      actions["create_issue"]!,
      {
        namespace: "g",
        project: "p",
        title: "T",
        description: "Desc",
        labels: ["bug", "help wanted"],
        assignee_ids: [1, 2],
        milestone_id: 10,
        due_date: "2024-12-31",
      },
      sdk,
    );

    expect(captured["description"]).toBe("Desc");
    expect(captured["labels"]).toBe("bug,help wanted");
    expect(captured["assignee_ids"]).toEqual([1, 2]);
    expect(captured["milestone_id"]).toBe(10);
    expect(captured["due_date"]).toBe("2024-12-31");
  });

  it("schema rejects empty title", () => {
    const actions = buildIssuesActions(baseDeps);
    expect(() =>
      actions["create_issue"]!.params.parse({
        namespace: "g",
        project: "p",
        title: "",
      }),
    ).toThrow();
  });

  it("schema rejects missing title", () => {
    const actions = buildIssuesActions(baseDeps);
    expect(() =>
      actions["create_issue"]!.params.parse({
        namespace: "g",
        project: "p",
      }),
    ).toThrow();
  });
});

// ── update_issue ──────────────────────────────────────────────────────────────

describe("update_issue", () => {
  it("updates title and passes labels as CSV", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      updateIssue: async (_ns, _proj, _iid, body) => {
        capturedBody = body as Record<string, unknown>;
        return {
          ok: true as const,
          status: 200,
          data: { ...issueResponse, title: "New title" },
        };
      },
    });
    const actions = buildIssuesActions(baseDeps);
    const result = (await runHandler(
      actions["update_issue"]!,
      {
        namespace: "g",
        project: "p",
        iid: 7,
        title: "New title",
        labels: ["enhancement"],
      },
      sdk,
    )) as Record<string, unknown>;

    expect(result["title"]).toBe("New title");
    expect(capturedBody["title"]).toBe("New title");
    expect(capturedBody["labels"]).toBe("enhancement");
  });

  it("schema rejects state_event=close", () => {
    const actions = buildIssuesActions(baseDeps);
    expect(() =>
      actions["update_issue"]!.params.parse({
        namespace: "g",
        project: "p",
        iid: 7,
        state_event: "close",
      }),
    ).toThrow();
  });

  it("schema allows state_event=reopen", () => {
    const actions = buildIssuesActions(baseDeps);
    expect(() =>
      actions["update_issue"]!.params.parse({
        namespace: "g",
        project: "p",
        iid: 7,
        state_event: "reopen",
      }),
    ).not.toThrow();
  });

  it("omits undefined optional fields from body", async () => {
    let capturedBody: Record<string, unknown> = {};
    const sdk = fakeSdk({
      updateIssue: async (_ns, _proj, _iid, body) => {
        capturedBody = body as Record<string, unknown>;
        return { ok: true as const, status: 200, data: { ...issueResponse } };
      },
    });
    const actions = buildIssuesActions(baseDeps);
    await runHandler(
      actions["update_issue"]!,
      { namespace: "g", project: "p", iid: 7, title: "Only title" },
      sdk,
    );
    expect(capturedBody["description"]).toBeUndefined();
    expect(capturedBody["labels"]).toBeUndefined();
    expect(capturedBody["assignee_ids"]).toBeUndefined();
  });
});

// ── close_issue ───────────────────────────────────────────────────────────────

describe("close_issue", () => {
  it("calls closeIssue and returns closed:true", async () => {
    const sdk = fakeSdk({
      closeIssue: async () => ({
        ok: true as const,
        status: 200,
        data: { ...issueResponse, state: "closed" },
      }),
    });
    const actions = buildIssuesActions(baseDeps);
    const result = (await runHandler(
      actions["close_issue"]!,
      { namespace: "g", project: "p", iid: 7 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["closed"]).toBe(true);
    expect(result["state"]).toBe("closed");
    expect(result["iid"]).toBe(7);
  });

  it("envelope includes expected fields", async () => {
    const sdk = fakeSdk({
      closeIssue: async () => ({
        ok: true as const,
        status: 200,
        data: { ...issueResponse, state: "closed" },
      }),
    });
    const actions = buildIssuesActions(baseDeps);
    const result = (await runHandler(
      actions["close_issue"]!,
      { namespace: "g", project: "p", iid: 7 },
      sdk,
    )) as Record<string, unknown>;

    expect(result["author"]).toBe("alice");
    expect(result["labels"]).toEqual(["bug", "v2"]);
    expect(result["web_url"]).toBe("https://gitlab.com/g/p/-/issues/7");
  });
});
