/**
 * Coverage extras for notion_client.ts — targets the request() retry loop,
 * timeout/network classification, classifyHttpStatus, parseRetryAfter,
 * extractTitleFromPage edge cases, and normalizeFileBlock early returns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotionClient,
  type NotionClientOptions,
  extractTitleFromPage,
} from "../../../../src/connectors/notion/lib/notion_client.js";

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
  overrides: Partial<NotionClientOptions> = {},
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
): NotionClient {
  return new NotionClient({
    token: "secret_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 10,
    readTimeoutMs: 10,
    fetchImpl: fetchMock
      ? (async (url, init) => fetchMock(String(url), init))
      : undefined,
    sleepImpl: async () => {},
    ...overrides,
  });
}

describe("NotionClient.request — retry & timeout branches", () => {
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
        return jsonResponse({ ok: true, results: [] });
      },
    );
    const r = await client.request("GET", "/v1/pages/abc");
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
        return jsonResponse({ ok: true });
      },
    );
    const r = await client.request("GET", "/v1/pages/abc");
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(500);
    expect(sleeps[1]).toBe(1000);
    expect(r.ok).toBe(true);
  });

  it("returns SERVER_ERROR after MAX_ATTEMPTS exhausted", async () => {
    const client = makeClient({}, async () =>
      new Response("nope", { status: 500 }),
    );
    const r = await client.request("GET", "/v1/pages/abc");
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
    const r = await client.request("GET", "/v1/pages/abc");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("RATE_LIMITED");
    }
  });

  it("classifies DOMException as TIMEOUT and retries then succeeds", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      if (calls === 1) {
        throw new DOMException("aborted", "AbortError");
      }
      return jsonResponse({ ok: true });
    });
    const r = await client.request("GET", "/v1/pages/abc");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("returns TIMEOUT after MAX_ATTEMPTS of DOMException", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.request("GET", "/v1/pages/abc");
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
    const r = await client.request("GET", "/v1/pages/abc");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toContain("ECONNRESET");
    }
  });

  it("classifies a non-Error throwable as NETWORK_ERROR with stringified value", async () => {
    const client = makeClient({}, async () => {
      throw "raw string error";
    });
    const r = await client.request("GET", "/v1/pages/abc");
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
    const r = await client.request("GET", "/v1/pages/abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_REQUEST");
  });

  it("rejects unrecognized HTTP method as METHOD_NOT_ALLOWED", async () => {
    const client = makeClient();
    const r = await client.request("DELETE" as never, "/v1/pages/abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("allows POST_READ_ONLY on database query path via regex", async () => {
    let calledMethod = "";
    const client = makeClient({}, async (_url, init) => {
      calledMethod = String(init?.method);
      return jsonResponse({ results: [] });
    });
    const dbId = "a".repeat(32);
    const r = await client.request(
      "POST_READ_ONLY",
      `/v1/databases/${dbId}/query`,
      { page_size: 5 },
    );
    expect(calledMethod).toBe("POST");
    expect(r.ok).toBe(true);
  });

  it("rejects an invalid api base URL at construction", () => {
    expect(
      () =>
        new NotionClient({
          token: "t",
          apiBase: "not-a-url",
          fetchImpl: globalThis.fetch,
          sleepImpl: async () => {},
        }),
    ).toThrow(/Invalid Notion API base/);
  });
});

describe("NotionClient — _throttle()", () => {
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
      const fetchMock = async () => jsonResponse({ ok: true });
      // Drive 3 requests; the 3rd must sleep before issuing.
      const stub = vi
        .spyOn(client as unknown as { _fetch: typeof globalThis.fetch }, "_fetch")
        .mockImplementation(fetchMock as never);
      try {
        await client.request("GET", "/v1/pages/a");
        await client.request("GET", "/v1/pages/b");
        await client.request("GET", "/v1/pages/c");
      } finally {
        stub.mockRestore();
      }
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("classifyHttpStatus — covered via request() error branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [403, "FORBIDDEN"],
    [400, "BAD_REQUEST"],
    [422, "UNPROCESSABLE"],
    [418, "HTTP_ERROR"],
  ])("status %i maps to %s", async (status, code) => {
    const client = makeClient({}, async () =>
      jsonResponse({ message: "x" }, { status }),
    );
    const r = await client.request("GET", "/v1/pages/abc");
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
        return jsonResponse({ ok: true });
      },
    );
    await client.request("GET", "/v1/pages/abc");
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
        return jsonResponse({ ok: true });
      },
    );
    await client.request("GET", "/v1/pages/abc");
    expect(sleeps[0]).toBe(500);
  });
});

describe("extractTitleFromPage — edge cases", () => {
  it("returns empty string when properties is missing", () => {
    expect(extractTitleFromPage({ id: "p" })).toBe("");
  });

  it("returns empty string when no property has type=title", () => {
    expect(
      extractTitleFromPage({
        id: "p",
        properties: { Status: { type: "select" } },
      }),
    ).toBe("");
  });

  it("returns empty string when title property is not an array", () => {
    expect(
      extractTitleFromPage({
        id: "p",
        properties: { Name: { type: "title", title: "not-an-array" } },
      }),
    ).toBe("");
  });

  it("treats non-object items in title array as empty string", () => {
    expect(
      extractTitleFromPage({
        id: "p",
        properties: {
          Name: { type: "title", title: [{ plain_text: "Hi" }, "string-item", null] },
        },
      }),
    ).toBe("Hi");
  });

  it("treats title items with non-string plain_text as empty string", () => {
    expect(
      extractTitleFromPage({
        id: "p",
        properties: {
          Name: { type: "title", title: [{ plain_text: "A" }, { plain_text: 42 }] },
        },
      }),
    ).toBe("A");
  });

  it("ignores null/array property values", () => {
    expect(
      extractTitleFromPage({
        id: "p",
        properties: { A: null, B: ["x"], C: { type: "title", title: [{ plain_text: "ok" }] } },
      }),
    ).toBe("ok");
  });
});

describe("listPageFileBlocks — normalizeFileBlock early returns", () => {
  afterEach(() => vi.restoreAllMocks());

  it("filters out blocks of non-file types", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          { id: "a", type: "paragraph", paragraph: { rich_text: [] } },
          { id: "b", type: "heading_1", heading_1: { rich_text: [] } },
        ],
        has_more: false,
      }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.results).toHaveLength(0);
  });

  it("filters file blocks whose payload is missing", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [{ id: "a", type: "file" }, { id: "b", type: "image", image: null }],
        has_more: false,
      }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.results).toHaveLength(0);
  });

  it("filters file blocks whose url type is neither 'file' nor 'external'", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          {
            id: "a",
            type: "file",
            file: { type: "weird", file: { url: "x" } },
          },
        ],
        has_more: false,
      }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.results).toHaveLength(0);
  });

  it("filters file blocks whose url is empty", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          { id: "a", type: "file", file: { type: "file", file: {} } },
          { id: "b", type: "image", image: { type: "external", external: {} } },
        ],
        has_more: false,
      }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.results).toHaveLength(0);
  });

  it("propagates a request error as the listPageFileBlocks result", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({}, { status: 404 }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("treats non-array caption as empty string", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          {
            id: "a",
            type: "file",
            file: {
              type: "file",
              file: { url: "https://example/x.pdf" },
              caption: "not-array",
            },
          },
        ],
        has_more: false,
      }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results[0]?.caption).toBe("");
    }
  });

  it("treats non-string caption rich-text items as empty string", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          {
            id: "a",
            type: "file",
            file: {
              type: "file",
              file: { url: "https://example/x.pdf" },
              caption: [{ plain_text: 123 }, "raw-string", null, { plain_text: "Hi" }],
            },
          },
        ],
        has_more: false,
      }),
    );
    const r = await client.listPageFileBlocks("p");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.results[0]?.caption).toBe("Hi");
  });
});

describe("getComments — empty and missing-field paths", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handles missing rich_text / created_by / parent fields", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          { id: "c1" }, // all optional fields missing
          { id: "c2", parent: {}, created_by: {}, rich_text: [] },
        ],
        has_more: false,
      }),
    );
    const r = await client.getComments("blockA");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(2);
      expect(r.data.results[0]?.author_id).toBe("");
      expect(r.data.results[0]?.body_plain).toBe("");
      expect(r.data.results[0]?.parent_page_id).toBeNull();
    }
  });

  it("propagates a request error as the getComments result", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({}, { status: 403 }),
    );
    const r = await client.getComments("blockA");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORBIDDEN");
  });
});
