/**
 * Write-action integration tests for the Linear connector.
 * Uses hand-rolled fetch mocks (no real HTTP). Covers happy paths for all
 * 7 write actions and read happy paths for get_issue, search_issues, get_team.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLinearConnector } from "../../../../src/connectors/linear/index.js";
import { LinearClient, type LinearClientOptions } from "../../../../src/connectors/linear/lib/linear_client.js";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function makeClient(
  fetchMock: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<LinearClientOptions> = {},
): LinearClient {
  return new LinearClient({
    apiKey: "lin_test_key",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url, init) => fetchMock(String(url), init),
    sleepImpl: async () => {},
    ...overrides,
  });
}

function makeWriteConnector(
  fetchMock: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const client = makeClient(fetchMock);
  return buildLinearConnector({
    sdk: async () => client,
    credentials: async () => ({ api_key: "lin_test_key" }),
    defaultPolicy: { read: "success", write: "success", admin: "denied" },
  });
}

const VALID_UUID = "a1b2c3d4e5f678901234567890123456";
const VALID_ISSUE_ID = "ENG-42";

// ── Read actions ────────────────────────────────────────────────────────────

describe("linear connector — get_issue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns shaped issue envelope on success", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          issue: {
            id: VALID_UUID,
            identifier: "ENG-42",
            title: "Fix auth redirect",
            description: "## Problem\n\nUsers are redirected incorrectly.",
            priority: 2,
            url: "https://linear.app/team/issue/ENG-42",
            archivedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-02-01T00:00:00Z",
            state: { id: "s1", name: "In Progress", type: "started" },
            assignee: { id: "u1", name: "Alice", email: "alice@example.com", displayName: "Alice Smith" },
            team: { id: "t1", key: "ENG", name: "Engineering" },
            labels: { nodes: [{ id: "l1", name: "bug", color: "#f00" }] },
          },
        },
      }),
    );
    const r = await c.fetch("get_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["identifier"]).toBe("ENG-42");
      expect(r.data["title"]).toBe("Fix auth redirect");
      expect((r.data["state"] as Record<string, unknown>)?.["name"]).toBe("In Progress");
      expect((r.data["assignee"] as Record<string, unknown>)?.["displayName"]).toBe("Alice Smith");
      const labels = r.data["labels"] as Array<Record<string, unknown>>;
      expect(labels).toHaveLength(1);
      expect(labels[0]?.["name"]).toBe("bug");
    }
  });

  it("returns NOT_FOUND when issue is null", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({ data: { issue: null } }),
    );
    const r = await c.fetch("get_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });

  it("rejects invalid identifier format", async () => {
    const c = makeWriteConnector(async () => jsonResponse({ data: {} }));
    const r = await c.fetch("get_issue", { id: "not-valid!" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });
});

describe("linear connector — search_issues", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns shaped search envelope", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: VALID_UUID,
                identifier: "ENG-1",
                title: "Test issue",
                priority: 3,
                url: "https://linear.app/t/i/ENG-1",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                state: { name: "Todo", type: "unstarted" },
                assignee: null,
                team: { key: "ENG", name: "Engineering" },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    );
    const r = await c.fetch("search_issues", { team_key: "ENG", max_results: 10 });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["total"]).toBe(1);
      const issues = r.data["issues"] as Array<Record<string, unknown>>;
      expect(issues[0]?.["identifier"]).toBe("ENG-1");
      expect(r.data["truncated"]).toBe(false);
    }
  });
});

describe("linear connector — get_team", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns team data by UUID", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          team: {
            id: VALID_UUID,
            key: "ENG",
            name: "Engineering",
            description: "Core engineering team",
          },
        },
      }),
    );
    const r = await c.fetch("get_team", { key_or_id: VALID_UUID });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["key"]).toBe("ENG");
      expect(r.data["name"]).toBe("Engineering");
    }
  });

  it("returns team data by short key (TEAMS_BY_KEY path)", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          teams: {
            nodes: [
              {
                id: VALID_UUID,
                key: "ENG",
                name: "Engineering",
                description: "Core engineering team",
              },
            ],
          },
        },
      }),
    );
    const r = await c.fetch("get_team", { key_or_id: "ENG" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["key"]).toBe("ENG");
      expect(r.data["name"]).toBe("Engineering");
    }
  });

  it("returns NOT_FOUND when key search yields empty nodes", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          teams: { nodes: [] },
        },
      }),
    );
    const r = await c.fetch("get_team", { key_or_id: "NOPE" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });
});

// ── Additional read actions ─────────────────────────────────────────────────

describe("linear connector — get_attachment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns VALIDATION_ERROR with list_attachments guidance", async () => {
    const c = makeWriteConnector(async () => jsonResponse({ data: {} }));
    const r = await c.fetch("get_attachment", { attachment_id: VALID_UUID });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("VALIDATION_ERROR");
      expect(r.message).toContain("list_attachments");
    }
  });
});

describe("linear connector — get_comments", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns shaped comments envelope on success", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          issue: {
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  body: "Looks good!",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                  user: { id: "u1", name: "Alice", displayName: "Alice Smith", email: "alice@example.com" },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      }),
    );
    const r = await c.fetch("get_comments", { issue_id: VALID_ISSUE_ID });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["issue_id"]).toBe(VALID_ISSUE_ID);
      const comments = r.data["comments"] as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0]?.["comment_id"]).toBe("comment-1");
    }
  });

  it("returns NOT_FOUND when issue is null", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({ data: { issue: null } }),
    );
    const r = await c.fetch("get_comments", { issue_id: VALID_ISSUE_ID });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });
});

describe("linear connector — list_attachments", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns shaped attachments envelope on success", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          issue: {
            attachments: {
              nodes: [
                {
                  id: VALID_UUID,
                  title: "Design doc",
                  subtitle: null,
                  url: "https://figma.com/file/abc",
                  createdAt: "2026-01-01T00:00:00Z",
                  creator: { displayName: "Alice" },
                },
              ],
            },
          },
        },
      }),
    );
    const r = await c.fetch("list_attachments", { issue_id: VALID_ISSUE_ID });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["issue_id"]).toBe(VALID_ISSUE_ID);
      const attachments = r.data["attachments"] as Array<Record<string, unknown>>;
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.["title"]).toBe("Design doc");
    }
  });
});

describe("linear connector — get_project", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns shaped project envelope on success", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({
        data: {
          project: {
            id: VALID_UUID,
            name: "Q3 Roadmap",
            description: "All Q3 milestones",
            state: "started",
            startDate: "2026-07-01",
            targetDate: "2026-09-30",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-06-01T00:00:00Z",
          },
        },
      }),
    );
    const r = await c.fetch("get_project", { id: VALID_UUID });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["id"]).toBe(VALID_UUID);
      expect(r.data["name"]).toBe("Q3 Roadmap");
    }
  });
});

// ── Write actions ───────────────────────────────────────────────────────────

describe("linear connector — create_issue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs GraphQL mutation and returns shaped envelope", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: VALID_UUID,
              identifier: "ENG-99",
              url: "https://linear.app/team/issue/ENG-99",
              title: "New feature",
              createdAt: "2026-05-01T00:00:00Z",
            },
          },
        },
      });
    });
    const r = await c.fetch("create_issue", {
      team_id: VALID_UUID,
      title: "New feature",
      description: "## Details\n\nImplement the new feature.",
    });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("issueCreate");
    const vars = body["variables"] as Record<string, unknown>;
    const input = vars["input"] as Record<string, unknown>;
    expect(input["teamId"]).toBe(VALID_UUID);
    expect(input["title"]).toBe("New feature");
    expect(input["description"]).toBe("## Details\n\nImplement the new feature.");
    if (r.status === "success") {
      expect(r.data["identifier"]).toBe("ENG-99");
      expect(r.data["url"]).toContain("ENG-99");
    }
  });

  it("rejects invalid team_id", async () => {
    const c = makeWriteConnector(async () => jsonResponse({ data: {} }));
    const r = await c.fetch("create_issue", {
      team_id: "not-a-uuid",
      title: "Test",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });
});

describe("linear connector — update_issue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends update mutation with correct variables", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: VALID_UUID, identifier: "ENG-42", updatedAt: "2026-05-01T00:00:00Z" },
          },
        },
      });
    });
    const r = await c.fetch("update_issue", {
      id: VALID_ISSUE_ID,
      title: "Updated title",
      priority: 1,
    });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("issueUpdate");
    const vars = body["variables"] as Record<string, unknown>;
    expect(vars["id"]).toBe(VALID_ISSUE_ID);
    const input = vars["input"] as Record<string, unknown>;
    expect(input["title"]).toBe("Updated title");
    expect(input["priority"]).toBe(1);
    if (r.status === "success") {
      expect(r.data["updated"]).toBe(true);
    }
  });
});

describe("linear connector — archive_issue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends issueArchive mutation and returns archived: true", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: { issueArchive: { success: true } },
      });
    });
    const r = await c.fetch("archive_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("issueArchive");
    if (r.status === "success") {
      expect(r.data["archived"]).toBe(true);
      expect(r.data["id"]).toBe(VALID_ISSUE_ID);
    }
  });
});

describe("linear connector — add_comment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends commentCreate mutation with markdown body", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-uuid",
              body: "## Update\n\nDone!",
              createdAt: "2026-05-01T00:00:00Z",
              user: { displayName: "Alice" },
            },
          },
        },
      });
    });
    const r = await c.fetch("add_comment", {
      issue_id: VALID_ISSUE_ID,
      body: "## Update\n\nDone!",
    });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("commentCreate");
    const vars = body["variables"] as Record<string, unknown>;
    const input = vars["input"] as Record<string, unknown>;
    expect(input["issueId"]).toBe(VALID_ISSUE_ID);
    expect(input["body"]).toBe("## Update\n\nDone!");
    if (r.status === "success") {
      expect(r.data["comment_id"]).toBe("comment-uuid");
      expect(r.data["author"]).toBe("Alice");
    }
  });

  it("rejects empty body", async () => {
    const c = makeWriteConnector(async () => jsonResponse({ data: {} }));
    const r = await c.fetch("add_comment", {
      issue_id: VALID_ISSUE_ID,
      body: "",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });
});

describe("linear connector — update_comment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends commentUpdate mutation with new body", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          commentUpdate: {
            success: true,
            comment: { id: VALID_UUID, body: "Updated body", updatedAt: "2026-05-01T00:00:00Z" },
          },
        },
      });
    });
    const r = await c.fetch("update_comment", {
      comment_id: VALID_UUID,
      body: "Updated body",
    });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("commentUpdate");
    const vars = body["variables"] as Record<string, unknown>;
    expect(vars["id"]).toBe(VALID_UUID);
    if (r.status === "success") {
      expect(r.data["updated"]).toBe(true);
    }
  });
});

describe("linear connector — delete_comment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends commentDelete mutation and returns deleted: true", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: { commentDelete: { success: true } },
      });
    });
    const r = await c.fetch("delete_comment", { comment_id: VALID_UUID });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("commentDelete");
    if (r.status === "success") {
      expect(r.data["deleted"]).toBe(true);
      expect(r.data["comment_id"]).toBe(VALID_UUID);
    }
  });
});

describe("linear connector — attachment_link", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends attachmentCreate mutation with correct variables", async () => {
    let body: Record<string, unknown> = {};
    const c = makeWriteConnector(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          attachmentCreate: {
            success: true,
            attachment: {
              id: VALID_UUID,
              title: "Design doc",
              url: "https://figma.com/file/abc",
              createdAt: "2026-05-01T00:00:00Z",
            },
          },
        },
      });
    });
    const r = await c.fetch("attachment_link", {
      issue_id: VALID_ISSUE_ID,
      title: "Design doc",
      url: "https://figma.com/file/abc",
      subtitle: "v3 iteration",
    });
    expect(r.status).toBe("success");
    expect(String(body["query"])).toContain("attachmentCreate");
    const vars = body["variables"] as Record<string, unknown>;
    const input = vars["input"] as Record<string, unknown>;
    expect(input["issueId"]).toBe(VALID_ISSUE_ID);
    expect(input["title"]).toBe("Design doc");
    expect(input["url"]).toBe("https://figma.com/file/abc");
    expect(input["subtitle"]).toBe("v3 iteration");
    if (r.status === "success") {
      expect(r.data["attachment_id"]).toBe(VALID_UUID);
      expect(r.data["url"]).toBe("https://figma.com/file/abc");
    }
  });

  it("rejects invalid URL", async () => {
    const c = makeWriteConnector(async () => jsonResponse({ data: {} }));
    const r = await c.fetch("attachment_link", {
      issue_id: VALID_ISSUE_ID,
      title: "Bad link",
      url: "not-a-url",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });
});

describe("linear connector — validActions", () => {
  it("exposes all 14 actions", () => {
    const c = buildLinearConnector();
    expect([...c.validActions].sort()).toEqual([
      "add_comment",
      "archive_issue",
      "attachment_link",
      "create_issue",
      "delete_comment",
      "get_attachment",
      "get_comments",
      "get_issue",
      "get_project",
      "get_team",
      "list_attachments",
      "search_issues",
      "update_comment",
      "update_issue",
    ]);
  });
});

describe("linear connector — AUTH and CONFIG errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("surfaces 401 as AUTH_ERROR", async () => {
    const c = makeWriteConnector(async () =>
      jsonResponse({ message: "Unauthorized" }, { status: 401 }),
    );
    const r = await c.fetch("get_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("AUTH_ERROR");
  });

  it("returns CONFIG_ERROR when LINEAR_API_KEY missing", async () => {
    const origKey = process.env["LINEAR_API_KEY"];
    delete process.env["LINEAR_API_KEY"];
    const c = buildLinearConnector();
    const r = await c.fetch("get_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.message).toContain("LINEAR_API_KEY");
    }
    if (origKey !== undefined) process.env["LINEAR_API_KEY"] = origKey;
  });
});
