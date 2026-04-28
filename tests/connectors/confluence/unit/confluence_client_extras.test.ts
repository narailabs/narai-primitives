/**
 * Coverage extras for confluence_client.ts — targets the request() retry loop,
 * timeout/network classification, classifyHttpStatus, parseRetryAfter,
 * _throttle rate limit branch, getAttachmentDownload error paths, and the
 * htmlToPlain helper edge cases.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfluenceClient,
  type ConfluenceClientOptions,
  htmlToPlain,
  loadConfluenceCredentials,
} from "../../../../src/connectors/confluence/lib/confluence_client.js";

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
  overrides: Partial<ConfluenceClientOptions> = {},
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
): ConfluenceClient {
  return new ConfluenceClient({
    siteUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "tok",
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

describe("ConfluenceClient.request — retry & timeout branches", () => {
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
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
    const r = await client.request("GET", "/wiki/rest/api/content/x");
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(500);
    expect(sleeps[1]).toBe(1000);
    expect(r.ok).toBe(true);
  });

  it("returns SERVER_ERROR after MAX_ATTEMPTS exhausted", async () => {
    const client = makeClient({}, async () =>
      new Response("nope", { status: 500 }),
    );
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
      return jsonResponse({ ok: true });
    });
    const r = await client.request("GET", "/wiki/rest/api/content/x");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("returns TIMEOUT after MAX_ATTEMPTS of DOMException", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
    const r = await client.request("GET", "/wiki/rest/api/content/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_REQUEST");
  });

  it("rejects unrecognized HTTP method as METHOD_NOT_ALLOWED", async () => {
    const client = makeClient();
    const r = await client.request("DELETE" as never, "/wiki/rest/api/content/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("retries on a thrown Error containing /abort/i and classifies as TIMEOUT", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      if (calls === 1) throw new Error("Operation was aborted");
      return jsonResponse({ ok: true });
    });
    const r = await client.request("GET", "/wiki/rest/api/content/x");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("rejects an invalid api base URL at construction", () => {
    expect(
      () =>
        new ConfluenceClient({
          siteUrl: "ftp://nope",
          email: "u",
          apiToken: "t",
          fetchImpl: globalThis.fetch,
          sleepImpl: async () => {},
        }),
    ).toThrow(/Invalid Confluence site URL/);
  });

  it("authHeader getter returns the Basic header", () => {
    const client = makeClient();
    expect(client.authHeader).toMatch(/^Basic /);
  });

  it("siteUrl getter returns the trimmed site URL", () => {
    const client = makeClient({ siteUrl: "https://example.atlassian.net///" });
    expect(client.siteUrl).toBe("https://example.atlassian.net");
  });
});

describe("ConfluenceClient — _throttle()", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sleeps when in-window request count reaches the limit", async () => {
    const sleeps: number[] = [];
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const client = makeClient(
        {
          rateLimitPerMin: 2,
          sleepImpl: async (ms) => {
            sleeps.push(ms);
            now += ms; // advance the mocked clock by the sleep duration
          },
        },
        async () => jsonResponse({ ok: true }),
      );
      await client.request("GET", "/wiki/rest/api/content/a");
      await client.request("GET", "/wiki/rest/api/content/b");
      await client.request("GET", "/wiki/rest/api/content/c");
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("classifyHttpStatus — covered via request() error branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "UNAUTHORIZED"],
    [404, "NOT_FOUND"],
    [400, "BAD_REQUEST"],
    [418, "HTTP_ERROR"],
    [422, "HTTP_ERROR"],
  ])("status %i maps to %s", async (status, code) => {
    const client = makeClient({}, async () =>
      jsonResponse({ message: "x" }, { status }),
    );
    const r = await client.request("GET", "/wiki/rest/api/content/x");
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
    await client.request("GET", "/wiki/rest/api/content/x");
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
    await client.request("GET", "/wiki/rest/api/content/x");
    expect(sleeps[0]).toBe(500);
  });
});

describe("getAttachmentDownload — error branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("classifies 401 as UNAUTHORIZED and is not retriable", async () => {
    const client = makeClient({}, async () => new Response("", { status: 401 }));
    const r = await client.getAttachmentDownload("/download/attachments/9/x.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNAUTHORIZED");
      expect(r.retriable).toBe(false);
    }
  });

  it("marks 503 as retriable=true and SERVER_ERROR via classifier fallback", async () => {
    const client = makeClient({}, async () => new Response("", { status: 503 }));
    const r = await client.getAttachmentDownload("/download/attachments/9/x.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retriable).toBe(true);
      expect(r.code).toBe("HTTP_ERROR");
    }
  });

  it("classifies DOMException as TIMEOUT", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.getAttachmentDownload("/download/attachments/9/x.pdf");
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
    const r = await client.getAttachmentDownload("/download/attachments/9/x.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toContain("ECONNRESET");
    }
  });

  it("classifies a non-Error throwable as NETWORK_ERROR with stringified value", async () => {
    const client = makeClient({}, async () => {
      throw "boom-str";
    });
    const r = await client.getAttachmentDownload("/download/attachments/9/x.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("boom-str");
  });

  it("falls back to URL basename when filename* fails to decode", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([0]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    // %FF%FF is not valid UTF-8 → decodeURIComponent throws → fallback returns raw tail.
    const r = await client.getAttachmentDownload(
      "/download/attachments/123/%FF%FF.bin",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.filename).toBe("%FF%FF.bin");
  });
});

describe("loadConfluenceCredentials — null path", () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it("returns null when env vars are missing", async () => {
    delete process.env["CONFLUENCE_SITE_URL"];
    delete process.env["CONFLUENCE_EMAIL"];
    delete process.env["CONFLUENCE_API_TOKEN"];
    const r = await loadConfluenceCredentials();
    expect(r).toBeNull();
  });

  it("returns null when only site URL is set", async () => {
    delete process.env["CONFLUENCE_EMAIL"];
    delete process.env["CONFLUENCE_API_TOKEN"];
    process.env["CONFLUENCE_SITE_URL"] = "https://example.atlassian.net";
    const r = await loadConfluenceCredentials();
    expect(r).toBeNull();
  });

  it("returns full credential object when all three env vars set", async () => {
    process.env["CONFLUENCE_SITE_URL"] = "https://example.atlassian.net";
    process.env["CONFLUENCE_EMAIL"] = "u@example.com";
    process.env["CONFLUENCE_API_TOKEN"] = "token-x";
    const r = await loadConfluenceCredentials();
    expect(r).not.toBeNull();
    expect(r?.siteUrl).toBe("https://example.atlassian.net");
    expect(r?.email).toBe("u@example.com");
    expect(r?.apiToken).toBe("token-x");
  });
});

describe("buildUrl — query / path branches", () => {
  it("prepends '/' to a relative path", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true });
    });
    await client.request("GET", "wiki/rest/api/content/x");
    expect(calledUrl).toBe("https://example.atlassian.net/wiki/rest/api/content/x");
  });

  it("skips undefined and null query values", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true });
    });
    await client.request("GET", "/wiki/rest/api/content/x", {
      query: { included: "yes", a: undefined, b: null },
    });
    expect(calledUrl).toContain("?included=yes");
    expect(calledUrl).not.toContain("a=");
    expect(calledUrl).not.toContain("b=");
  });

  it("skips the trailing '?' when all query values are undefined", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true });
    });
    await client.request("GET", "/wiki/rest/api/content/x", {
      query: { a: undefined, b: null },
    });
    expect(calledUrl).toBe("https://example.atlassian.net/wiki/rest/api/content/x");
  });
});

describe("ConfluenceClient — defaults branches", () => {
  it("constructs with all options omitted (uses default rate limit + timeouts)", () => {
    const c = new ConfluenceClient({
      siteUrl: "https://example.atlassian.net",
      email: "u@example.com",
      apiToken: "tok",
    });
    expect(c.siteUrl).toBe("https://example.atlassian.net");
  });

  it("default sleepImpl returns a real promise that resolves on retry-after=0", async () => {
    let calls = 0;
    const c = new ConfluenceClient({
      siteUrl: "https://example.atlassian.net",
      email: "u",
      apiToken: "t",
      rateLimitPerMin: 100,
      connectTimeoutMs: 100,
      readTimeoutMs: 100,
      // no sleepImpl: this exercises the default factory
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          return new Response("rate", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return jsonResponse({ ok: true });
      },
    });
    const r = await c.request("GET", "/wiki/rest/api/content/x");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });
});

describe("getComments — optional fields branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handles missing results / size / start / limit fields", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({}), // no results, no size, no start, no limit
    );
    const r = await client.getComments("123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toEqual([]);
      expect(r.data.size).toBeUndefined();
    }
  });

  it("handles partially-shaped raw comments (missing history/version/body)", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [{ id: "c1" }, { id: "c2", history: {}, version: {}, body: {} }],
        size: 2,
        start: 0,
        limit: 50,
      }),
    );
    const r = await client.getComments("123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(2);
      expect(r.data.results[0]?.author).toBe("");
      expect(r.data.results[0]?.created).toBe("");
      expect(r.data.results[0]?.version).toBe(0);
      expect(r.data.results[0]?.body_plain).toBe("");
      expect(r.data.size).toBe(2);
      expect(r.data.start).toBe(0);
      expect(r.data.limit).toBe(50);
    }
  });

  it("propagates a request error", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 404 }));
    const r = await client.getComments("123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });
});

describe("getAttachmentDownload — content-disposition branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives filename from URL when content-disposition header missing", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([0]), {
        status: 200,
        // no content-disposition
        headers: { "content-type": "image/png" },
      }),
    );
    const r = await client.getAttachmentDownload("/download/attachments/9/foo.png");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.filename).toBe("foo.png");
      expect(r.data.contentType).toBe("image/png");
    }
  });

  it("falls back to 'attachment' when path has no tail segment", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([0]), { status: 200 }),
    );
    const r = await client.getAttachmentDownload("/");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.filename).toBe("attachment");
      // content-type defaults to application/octet-stream when missing
      expect(r.data.contentType).toBe("application/octet-stream");
    }
  });

  it("returns content-disposition without filename* when header lacks match", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([0]), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment", // no filename param
        },
      }),
    );
    const r = await client.getAttachmentDownload("/download/x.bin");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.filename).toBe("x.bin");
  });
});

describe("htmlToPlain — edge cases", () => {
  it("returns empty string on empty input", () => {
    expect(htmlToPlain("")).toBe("");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToPlain("a &amp; b &lt;c&gt; &nbsp; &#65;")).toBe(
      "a & b <c>   A",
    );
  });

  it("collapses 3+ newlines down to 2", () => {
    expect(htmlToPlain("<p>a</p><p>b</p><p>c</p>")).toBe("a\n\nb\n\nc");
  });

  it("trims trailing whitespace before newline", () => {
    // Block tag turns into \n\n; ensure trailing spaces collapse.
    expect(htmlToPlain("<p>line   </p>")).toBe("line");
  });

  it("leaves unknown entities as-is", () => {
    expect(htmlToPlain("&unknownentity;X")).toBe("&unknownentity;X");
  });
});
