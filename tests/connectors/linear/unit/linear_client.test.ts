/**
 * Unit tests for LinearClient — GraphQL client.
 * Covers: auth header (no Bearer), retry on 429/5xx, timeouts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearClient } from "../../../../src/connectors/linear/lib/linear_client.js";

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
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
  extra: { rateLimitPerMin?: number; connectTimeoutMs?: number; readTimeoutMs?: number } = {},
): LinearClient {
  return new LinearClient({
    apiKey: "lin_api_abc123",
    rateLimitPerMin: extra.rateLimitPerMin ?? 100,
    connectTimeoutMs: extra.connectTimeoutMs ?? 50,
    readTimeoutMs: extra.readTimeoutMs ?? 50,
    fetchImpl: fetchMock
      ? (async (url, init) => fetchMock(String(url), init))
      : undefined,
    sleepImpl: async () => {},
  });
}

const SIMPLE_QUERY = `query { viewer { id } }`;
const GQL_ENDPOINT = "https://api.linear.app/graphql";

describe("LinearClient — auth header", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends Authorization header without Bearer prefix", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = makeClient(async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries(),
      );
      return jsonResponse({ data: { viewer: { id: "user1" } } });
    });
    await client.query(SIMPLE_QUERY);
    expect(capturedHeaders["authorization"]).toBe("lin_api_abc123");
    expect(capturedHeaders["authorization"]).not.toMatch(/^Bearer /);
  });

  it("sends Content-Type: application/json", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = makeClient(async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries(),
      );
      return jsonResponse({ data: {} });
    });
    await client.query(SIMPLE_QUERY);
    expect(capturedHeaders["content-type"]).toBe("application/json");
  });

  it("POSTs to the correct Linear GraphQL endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const client = makeClient(async (url, init) => {
      capturedUrl = url;
      capturedMethod = String(init?.method ?? "");
      return jsonResponse({ data: {} });
    });
    await client.query(SIMPLE_QUERY);
    expect(capturedUrl).toBe(GQL_ENDPOINT);
    expect(capturedMethod).toBe("POST");
  });

  it("sends query and variables in request body", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({ data: {} });
    });
    await client.query(SIMPLE_QUERY, { id: "ENG-1" });
    expect(body["query"]).toBe(SIMPLE_QUERY);
    expect((body["variables"] as Record<string, unknown>)["id"]).toBe("ENG-1");
  });
});

describe("LinearClient — retry on 429 and 5xx", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries on 429 and succeeds on next attempt", async () => {
    let attempt = 0;
    const client = makeClient(async () => {
      attempt++;
      if (attempt === 1) return jsonResponse({}, { status: 429 });
      return jsonResponse({ data: { viewer: { id: "u1" } } });
    });
    const r = await client.query<{ viewer: { id: string } }>(SIMPLE_QUERY);
    expect(r.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it("retries on 500 and succeeds on next attempt", async () => {
    let attempt = 0;
    const client = makeClient(async () => {
      attempt++;
      if (attempt === 1) return jsonResponse({}, { status: 500 });
      return jsonResponse({ data: { viewer: { id: "u1" } } });
    });
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it("exhausts retries and returns RATE_LIMITED after persistent 429", async () => {
    const client = makeClient(async () =>
      jsonResponse({}, { status: 429 }),
    );
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("RATE_LIMITED");
      expect(r.retriable).toBe(true);
    }
  });

  it("exhausts retries and returns SERVER_ERROR after persistent 503", async () => {
    const client = makeClient(async () =>
      jsonResponse({}, { status: 503 }),
    );
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SERVER_ERROR");
      expect(r.retriable).toBe(true);
    }
  });

  it("honours Retry-After header on 429", async () => {
    let slept = 0;
    let attempt = 0;
    const client = new LinearClient({
      apiKey: "key",
      rateLimitPerMin: 100,
      connectTimeoutMs: 50,
      readTimeoutMs: 50,
      fetchImpl: async () => {
        attempt++;
        if (attempt === 1) {
          return jsonResponse({}, { status: 429, headers: { "retry-after": "2" } });
        }
        return jsonResponse({ data: {} });
      },
      sleepImpl: async (ms) => { slept += ms; },
    });
    await client.query(SIMPLE_QUERY);
    // Retry-After: 2 → 2000ms sleep
    expect(slept).toBeGreaterThanOrEqual(2000);
  });
});

describe("LinearClient — network errors and timeouts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns TIMEOUT on aborted request", async () => {
    const client = makeClient(async () => {
      const e = new DOMException("The operation was aborted.", "AbortError");
      throw e;
    });
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TIMEOUT");
      expect(r.retriable).toBe(true);
    }
  });

  it("returns NETWORK_ERROR on fetch throw", async () => {
    const client = makeClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
    }
  });

  it("returns GRAPHQL_ERROR when response has errors array", async () => {
    const client = makeClient(async () =>
      jsonResponse({
        errors: [{ message: "Entity not found", extensions: { code: "NOT_FOUND" } }],
      }),
    );
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NOT_FOUND");
      expect(r.message).toBe("Entity not found");
    }
  });

  it("returns AUTH_ERROR on 401", async () => {
    const client = makeClient(async () =>
      jsonResponse({ message: "Unauthorized" }, { status: 401 }),
    );
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNAUTHORIZED");
    }
  });

  it("returns NOT_FOUND on 404", async () => {
    const client = makeClient(async () =>
      jsonResponse({ message: "Not found" }, { status: 404 }),
    );
    const r = await client.query(SIMPLE_QUERY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NOT_FOUND");
    }
  });
});

describe("LinearClient — rate limiter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tracks request timestamps and resets via resetRateLimiter()", async () => {
    let callCount = 0;
    const client = makeClient(async () => {
      callCount++;
      return jsonResponse({ data: {} });
    });
    await client.query(SIMPLE_QUERY);
    await client.query(SIMPLE_QUERY);
    expect(callCount).toBe(2);
    client.resetRateLimiter();
    // After reset, still works normally
    await client.query(SIMPLE_QUERY);
    expect(callCount).toBe(3);
  });
});

describe("LinearClient — typed operations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getIssue passes id variable", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          issue: {
            id: "uuid-1",
            identifier: "ENG-5",
            title: "Test",
            description: null,
            priority: 2,
            url: "https://linear.app/t/i/ENG-5",
            archivedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            state: { id: "s1", name: "Todo", type: "unstarted" },
            assignee: null,
            team: { id: "t1", key: "ENG", name: "Engineering" },
            labels: { nodes: [] },
          },
        },
      });
    });
    const r = await client.getIssue("ENG-5");
    expect(r.ok).toBe(true);
    const vars = body["variables"] as Record<string, unknown>;
    expect(vars["id"]).toBe("ENG-5");
  });

  it("searchIssues builds filter correctly for team_key", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    });
    await client.searchIssues({ team_key: "ENG", max_results: 10 });
    const vars = body["variables"] as Record<string, unknown>;
    const filter = vars["filter"] as Record<string, unknown>;
    expect((filter["team"] as Record<string, unknown>)?.["key"]).toBeDefined();
  });

  it("archiveIssue sends ARCHIVE_ISSUE mutation", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        data: { issueArchive: { success: true } },
      });
    });
    const r = await client.archiveIssue("uuid-123");
    expect(r.ok).toBe(true);
    expect(String(body["query"])).toContain("issueArchive");
    const vars = body["variables"] as Record<string, unknown>;
    expect(vars["id"]).toBe("uuid-123");
  });

  it("deleteComment sends DELETE_COMMENT mutation", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({ data: { commentDelete: { success: true } } });
    });
    const r = await client.deleteComment("comment-uuid");
    expect(r.ok).toBe(true);
    expect(String(body["query"])).toContain("commentDelete");
  });
});
