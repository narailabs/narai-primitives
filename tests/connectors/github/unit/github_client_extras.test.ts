/**
 * Coverage extras for github_client.ts — targets the _send retry loop,
 * timeout/network classification, classifyHttpStatus / parseRetryAfter,
 * graphql() & listWikiPages() (entirely uncovered methods),
 * getReleaseAssetDownload error paths, _throttle rate-limit branch,
 * and loadGithubCredentials().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GithubClient,
  type GithubClientOptions,
  loadGithubCredentials,
} from "../../../../src/connectors/github/lib/github_client.js";

// Mock the credentials module so we can drive `loadGithubCredentials` deterministically.
vi.mock("@narai/credential-providers", () => ({
  resolveSecret: vi.fn(async () => null),
}));
import { resolveSecret } from "@narai/credential-providers";

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
  overrides: Partial<GithubClientOptions> = {},
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
): GithubClient {
  return new GithubClient({
    token: "ghp_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: fetchMock
      ? (async (url, init) => fetchMock(String(url), init))
      : undefined,
    sleepImpl: async () => {},
    ...overrides,
  });
}

describe("GithubClient._send — retry & timeout branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries on 429 with Retry-After header then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = makeClient(
      { sleepImpl: async (ms) => void sleeps.push(ms) },
      async () => {
        calls++;
        if (calls === 1) {
          return new Response("rate", {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }
        return jsonResponse({ full_name: "a/b" });
      },
    );
    const r = await client.getRepo("a", "b");
    expect(calls).toBe(2);
    expect(sleeps[0]).toBe(2000);
    expect(r.ok).toBe(true);
  });

  it("retries on 5xx without Retry-After using exponential backoff", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = makeClient(
      { sleepImpl: async (ms) => void sleeps.push(ms) },
      async () => {
        calls++;
        if (calls < 3) return new Response("boom", { status: 503 });
        return jsonResponse({ full_name: "a/b" });
      },
    );
    const r = await client.getRepo("a", "b");
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(500);
    expect(sleeps[1]).toBe(1000);
    expect(r.ok).toBe(true);
  });

  it("returns SERVER_ERROR after MAX_ATTEMPTS exhausted", async () => {
    const client = makeClient({}, async () =>
      new Response("nope", { status: 500 }),
    );
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SERVER_ERROR");
      expect(r.retriable).toBe(true);
      expect(r.status).toBe(500);
    }
  });

  it("returns RATE_LIMITED after MAX_ATTEMPTS exhausted on 429", async () => {
    const client = makeClient({}, async () =>
      new Response("rate", { status: 429 }),
    );
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("RATE_LIMITED");
      expect(r.retriable).toBe(true);
    }
  });

  it("returns RATE_LIMITED after MAX_ATTEMPTS on 403 with x-ratelimit-remaining=0", async () => {
    const client = makeClient({}, async () =>
      jsonResponse(
        {},
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      ),
    );
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("RATE_LIMITED");
  });

  it("classifies DOMException as TIMEOUT and retries then succeeds", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      if (calls === 1) {
        throw new DOMException("aborted", "AbortError");
      }
      return jsonResponse({ full_name: "a/b" });
    });
    const r = await client.getRepo("a", "b");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("returns TIMEOUT after MAX_ATTEMPTS of DOMException", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TIMEOUT");
      expect(r.retriable).toBe(true);
    }
  });

  it("classifies a non-DOMException Error as NETWORK_ERROR", async () => {
    const client = makeClient({}, async () => {
      throw new Error("ECONNRESET");
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toContain("ECONNRESET");
    }
  });

  it("classifies an Error message containing 'abort' as TIMEOUT", async () => {
    const client = makeClient({}, async () => {
      throw new Error("the request was aborted unexpectedly");
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TIMEOUT");
  });

  it("classifies a non-Error throwable as NETWORK_ERROR with stringified value", async () => {
    const client = makeClient({}, async () => {
      throw "raw string error";
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("raw string error");
  });

  it("recovers when response.text() throws on a 4xx body", async () => {
    const client = makeClient({}, async () => {
      return {
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => {
          throw new Error("read err");
        },
      } as unknown as Response;
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_REQUEST");
  });

  it("rejects an unrecognized HTTP method as METHOD_NOT_ALLOWED", async () => {
    const client = makeClient();
    // Use bracket-access to bypass private + reach `_send` directly.
    const send = (
      client as unknown as {
        _send: (
          method: string,
          url: string,
          body: unknown,
        ) => Promise<{ ok: boolean; code?: string }>;
      }
    )._send.bind(client);
    const r = await send("DELETE" as never, "https://api.github.com/x", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("rejects an invalid api base URL at construction", () => {
    expect(
      () =>
        new GithubClient({
          token: "t",
          apiBase: "ftp://invalid",
          fetchImpl: globalThis.fetch,
          sleepImpl: async () => {},
        }),
    ).toThrow(/Invalid GitHub API base/);
  });
});

describe("GithubClient.graphql() — POST /graphql path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends a POST with Content-Type and JSON body", async () => {
    let usedMethod = "";
    let usedUrl = "";
    let usedHeaders: Headers | undefined;
    let usedBody = "";
    const client = makeClient({}, async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedHeaders = new Headers(init?.headers as HeadersInit);
      usedBody = String(init?.body ?? "");
      return jsonResponse({ data: { repository: { hasWikiEnabled: true } } });
    });
    const r = await client.graphql("query Q($x:Int){x}", { x: 1 });
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/graphql$/);
    expect(usedHeaders?.get("content-type")).toBe("application/json");
    expect(usedHeaders?.get("authorization")).toBe("Bearer ghp_test");
    expect(JSON.parse(usedBody)).toEqual({
      query: "query Q($x:Int){x}",
      variables: { x: 1 },
    });
    expect(r.ok).toBe(true);
  });

  it("uses an empty variables object when caller omits them", async () => {
    let body = "";
    const client = makeClient({}, async (_url, init) => {
      body = String(init?.body ?? "");
      return jsonResponse({ data: {} });
    });
    await client.graphql("query{}");
    expect(JSON.parse(body)).toEqual({ query: "query{}", variables: {} });
  });
});

describe("GithubClient.listWikiPages — GraphQL repository wrapper", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns hasWikiEnabled=true when repo flag is true", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ data: { repository: { hasWikiEnabled: true } } }),
    );
    const r = await client.listWikiPages("a", "b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hasWikiEnabled).toBe(true);
  });

  it("returns hasWikiEnabled=false when payload is shaped differently", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ data: { repository: null } }),
    );
    const r = await client.listWikiPages("a", "b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hasWikiEnabled).toBe(false);
  });

  it("propagates a graphql error", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({}, { status: 401 }),
    );
    const r = await client.listWikiPages("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED");
  });
});

describe("classifyHttpStatus — covered via _send error branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [422, "UNPROCESSABLE"],
    [400, "BAD_REQUEST"],
    [418, "HTTP_ERROR"],
  ])("status %i maps to %s", async (status, code) => {
    // 403 here uses default header (no x-ratelimit-remaining) so it goes to
    // the generic 4xx classifier, not the rate-limit branch.
    const client = makeClient({}, async () =>
      jsonResponse({ message: "x" }, { status }),
    );
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
});

describe("parseRetryAfter — exercised via 429 path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignores invalid Retry-After and falls back to exponential backoff", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = makeClient(
      { sleepImpl: async (ms) => void sleeps.push(ms) },
      async () => {
        calls++;
        if (calls === 1) {
          return new Response("rate", {
            status: 429,
            headers: { "retry-after": "not-a-number" },
          });
        }
        return jsonResponse({ full_name: "a/b" });
      },
    );
    await client.getRepo("a", "b");
    expect(sleeps[0]).toBe(500);
  });

  it("ignores negative Retry-After and falls back to exponential backoff", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = makeClient(
      { sleepImpl: async (ms) => void sleeps.push(ms) },
      async () => {
        calls++;
        if (calls === 1) {
          return new Response("rate", {
            status: 429,
            headers: { "retry-after": "-5" },
          });
        }
        return jsonResponse({ full_name: "a/b" });
      },
    );
    await client.getRepo("a", "b");
    expect(sleeps[0]).toBe(500);
  });
});

describe("GithubClient — _throttle()", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sleeps when in-window request count reaches the limit", async () => {
    const sleeps: number[] = [];
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const client = makeClient({
        rateLimitPerMin: 2,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          now += ms; // advance the mocked clock by the sleep duration
        },
      });
      const stub = vi
        .spyOn(client as unknown as { _fetch: typeof globalThis.fetch }, "_fetch")
        .mockImplementation((async () =>
          jsonResponse({ full_name: "a/b" })) as never);
      try {
        await client.getRepo("a", "b");
        await client.getRepo("a", "c");
        await client.getRepo("a", "d");
      } finally {
        stub.mockRestore();
      }
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("GithubClient.getReleaseAssetDownload — error paths", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns classified HTTP error when response is non-2xx (404)", async () => {
    const client = makeClient({}, async () =>
      new Response("missing", { status: 404 }),
    );
    const r = await client.getReleaseAssetDownload("a", "b", 99);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NOT_FOUND");
      expect(r.retriable).toBe(false);
      expect(r.status).toBe(404);
    }
  });

  it("marks 5xx asset response as retriable", async () => {
    const client = makeClient({}, async () =>
      new Response("boom", { status: 502 }),
    );
    const r = await client.getReleaseAssetDownload("a", "b", 99);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retriable).toBe(true);
      expect(r.status).toBe(502);
    }
  });

  it("marks 429 asset response as retriable", async () => {
    const client = makeClient({}, async () =>
      new Response("rate", { status: 429 }),
    );
    const r = await client.getReleaseAssetDownload("a", "b", 99);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retriable).toBe(true);
  });

  it("classifies DOMException as TIMEOUT", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.getReleaseAssetDownload("a", "b", 99);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TIMEOUT");
      expect(r.retriable).toBe(true);
    }
  });

  it("classifies non-DOMException Error as NETWORK_ERROR", async () => {
    const client = makeClient({}, async () => {
      throw new Error("ECONNRESET");
    });
    const r = await client.getReleaseAssetDownload("a", "b", 99);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toContain("ECONNRESET");
    }
  });

  it("classifies a non-Error throwable as NETWORK_ERROR with stringified value", async () => {
    const client = makeClient({}, async () => {
      throw "raw asset error";
    });
    const r = await client.getReleaseAssetDownload("a", "b", 99);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("raw asset error");
  });

  it("falls back to default content-type and asset-N filename when headers are missing", async () => {
    const buf = new Uint8Array([1, 2, 3]);
    const client = makeClient({}, async () => {
      // Build a response with no content-type / content-disposition headers.
      return new Response(buf, { status: 200, headers: {} });
    });
    const r = await client.getReleaseAssetDownload("a", "b", 12345);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.contentType).toBe("application/octet-stream");
      expect(r.data.filename).toBe("asset-12345");
    }
  });
});

describe("normalize fallbacks — `?? ''` branches in comments / reviews / inline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getIssueComments fills default empty strings when fields are missing", async () => {
    const client = makeClient({}, async () =>
      jsonResponse([
        // Row with no user / created_at / updated_at / body / html_url —
        // forces every `?? ""` branch through its fallback side.
        { id: 7 },
      ]),
    );
    const r = await client.getIssueComments("a", "b", 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results[0]).toEqual({
        id: 7,
        author: "",
        created_at: "",
        updated_at: "",
        body_markdown: "",
        html_url: "",
      });
    }
  });

  it("getIssueComments handles a null data array as empty", async () => {
    const client = makeClient({}, async () => jsonResponse(null as unknown));
    const r = await client.getIssueComments("a", "b", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.results).toHaveLength(0);
  });

  it("getPullReviews fills default empty strings when fields are missing", async () => {
    const client = makeClient({}, async () => jsonResponse([{ id: 9 }]));
    const r = await client.getPullReviews("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data[0]).toEqual({
        id: 9,
        author: "",
        state: "",
        submitted_at: "",
        body_markdown: "",
        html_url: "",
      });
    }
  });

  it("getPullReviews handles a null data array as empty", async () => {
    const client = makeClient({}, async () => jsonResponse(null as unknown));
    const r = await client.getPullReviews("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toHaveLength(0);
  });

  it("getPullReviewComments fills empty defaults / null line when missing", async () => {
    const client = makeClient({}, async () =>
      jsonResponse([{ id: 11 }]),
    );
    const r = await client.getPullReviewComments("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data[0]).toEqual({
        id: 11,
        author: "",
        path: "",
        line: null,
        commit_id: "",
        created_at: "",
        updated_at: "",
        body_markdown: "",
        html_url: "",
        diff_hunk: "",
      });
    }
  });

  it("getPullReviewComments uses original_line when line is missing", async () => {
    const client = makeClient({}, async () =>
      jsonResponse([{ id: 11, original_line: 17 }]),
    );
    const r = await client.getPullReviewComments("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data[0]?.line).toBe(17);
  });

  it("getPullReviewComments handles a null data array as empty", async () => {
    const client = makeClient({}, async () => jsonResponse(null as unknown));
    const r = await client.getPullReviewComments("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toHaveLength(0);
  });
});

describe("listIssues / listPulls — opts branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listIssues includes labels, state, perPage, page query parameters", async () => {
    let called = "";
    const client = makeClient({}, async (url) => {
      called = url;
      return jsonResponse([]);
    });
    await client.listIssues("a", "b", {
      state: "closed",
      labels: ["bug", "p1"],
      perPage: 50,
      page: 2,
    });
    expect(called).toMatch(/state=closed/);
    expect(called).toMatch(/labels=bug%2Cp1/);
    expect(called).toMatch(/per_page=50/);
    expect(called).toMatch(/page=2/);
  });

  it("listPulls includes state, perPage, page query parameters", async () => {
    let called = "";
    const client = makeClient({}, async (url) => {
      called = url;
      return jsonResponse([]);
    });
    await client.listPulls("a", "b", {
      state: "closed",
      perPage: 50,
      page: 3,
    });
    expect(called).toMatch(/state=closed/);
    expect(called).toMatch(/per_page=50/);
    expect(called).toMatch(/page=3/);
  });
});

describe("buildUrl — undefined/null query values are skipped", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips undefined/null params and returns base URL alone when all are skipped", async () => {
    let called = "";
    const client = makeClient({}, async (url) => {
      called = url;
      return jsonResponse({ ok: true });
    });
    // The internal `get` accepts a query map; null/undefined values should be
    // dropped, so the resulting URL has no `?` suffix.
    await client.get("/x", { a: undefined, b: null });
    expect(called.endsWith("/x")).toBe(true);
  });
});

describe("parseContentDispositionFilename — covered via getReleaseAssetDownload", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses default asset-N filename when content-disposition has no filename match", async () => {
    const buf = new Uint8Array([7, 8]);
    const client = makeClient({}, async () =>
      new Response(buf, {
        status: 200,
        headers: { "content-disposition": "inline" }, // no filename token
      }),
    );
    const r = await client.getReleaseAssetDownload("a", "b", 42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.filename).toBe("asset-42");
  });
});

describe("truncate — covered via 4xx body suffix", () => {
  afterEach(() => vi.restoreAllMocks());

  it("appends ellipsis when 4xx body exceeds 200 chars", async () => {
    const longBody = "x".repeat(300);
    const client = makeClient({}, async () => new Response(longBody, { status: 400 }));
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("…");
      expect(r.message.length).toBeLessThan(longBody.length + 50);
    }
  });
});

describe("loadGithubCredentials()", () => {
  beforeEach(() => {
    vi.mocked(resolveSecret).mockReset();
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_OWNER"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns null when no token is found anywhere", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    const r = await loadGithubCredentials();
    expect(r).toBeNull();
  });

  it("uses GITHUB_TOKEN env var when resolveSecret returns null", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["GITHUB_TOKEN"] = "env-token";
    process.env["GITHUB_OWNER"] = "env-owner";
    const r = await loadGithubCredentials();
    expect(r).toEqual({ token: "env-token", defaultOwner: "env-owner" });
  });

  it("prefers resolveSecret value over env var when both are present", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) => {
      if (key === "GITHUB_TOKEN") return "secret-token";
      if (key === "GITHUB_OWNER") return "secret-owner";
      return null;
    });
    process.env["GITHUB_TOKEN"] = "env-token";
    process.env["GITHUB_OWNER"] = "env-owner";
    const r = await loadGithubCredentials();
    expect(r).toEqual({ token: "secret-token", defaultOwner: "secret-owner" });
  });

  it("returns null defaultOwner when neither secret nor env is set", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) =>
      key === "GITHUB_TOKEN" ? "tok" : null,
    );
    const r = await loadGithubCredentials();
    expect(r).toEqual({ token: "tok", defaultOwner: null });
  });
});
