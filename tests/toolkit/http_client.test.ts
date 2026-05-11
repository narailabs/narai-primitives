import { describe, it, expect } from "vitest";
import {
  HttpClient,
  type HttpClientOptions,
} from "../../src/toolkit/http_client.js";

// ─── Test scaffolding ────────────────────────────────────────────────────

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  const body = init.body;
  if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
    return new Response(body as BodyInit, { status, headers });
  }
  if (typeof body === "string") {
    return new Response(body, { status, headers });
  }
  if (body === undefined || status === 204) {
    return new Response(null, { status, headers });
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Response[] | ((call: FetchCall) => Response)): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (typeof responses === "function") return responses({ url, init });
    const r = responses[i++];
    if (!r) throw new Error(`mock fetch: no response for call ${i}`);
    return r;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function makeSleep(): {
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
    // resolve immediately — no real delay in tests
  };
  return { sleep, waits };
}

function makeClient(
  responses: Response[] | ((call: FetchCall) => Response),
  overrides: Partial<HttpClientOptions> = {},
): { client: HttpClient; calls: FetchCall[]; waits: number[] } {
  const { fetch, calls } = makeFetch(responses);
  const { sleep, waits } = makeSleep();
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeader: "Bearer test-token",
    serviceName: "Example",
    allowedMethods: new Set(["GET", "POST", "PUT", "DELETE"]),
    fetchImpl: fetch,
    sleepImpl: sleep,
    rateLimitPerMin: 100, // high so throttle doesn't fire by default
    ...overrides,
  });
  return { client, calls, waits };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("HttpClient constructor", () => {
  it("throws on an invalid base URL", () => {
    expect(() => new HttpClient({
      baseUrl: "not-a-url",
      authHeader: "Bearer x",
      serviceName: "X",
    })).toThrow(/Invalid base URL/);
  });

  it("strips trailing slashes from baseUrl", () => {
    const c = new HttpClient({
      baseUrl: "https://api.example.com///",
      authHeader: "Bearer x",
      serviceName: "X",
    });
    expect(c.baseUrl).toBe("https://api.example.com");
  });

  it("exposes host", () => {
    const c = new HttpClient({
      baseUrl: "https://api.example.com",
      authHeader: "Bearer x",
      serviceName: "X",
    });
    expect(c.host).toBe("api.example.com");
  });
});

describe("HttpClient.request happy path", () => {
  it("returns ok with parsed JSON data", async () => {
    const { client } = makeClient([mockResponse({ body: { hello: "world" } })]);
    const r = await client.request<{ hello: string }>("GET", "/things");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ hello: "world" });
      expect(r.status).toBe(200);
    }
  });

  it("attaches Authorization + default Accept headers", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })]);
    await client.request("GET", "/x");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer test-token");
    expect(h.Accept).toBe("application/json");
  });

  it("merges defaultHeaders and per-request headers", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })], {
      defaultHeaders: { "Notion-Version": "2024-01" },
    });
    await client.request("GET", "/x", { headers: { "X-Trace": "abc" } });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["Notion-Version"]).toBe("2024-01");
    expect(h["X-Trace"]).toBe("abc");
  });

  it("per-request headers override defaultHeaders", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })], {
      defaultHeaders: { Accept: "application/vnd.github+json" },
    });
    await client.request("GET", "/x", { headers: { Accept: "text/csv" } });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Accept).toBe("text/csv");
  });

  it("encodes query strings", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })]);
    await client.request("GET", "/search", {
      query: { q: "hello world", page: 2, skipped: null, alsoSkipped: undefined },
    });
    expect(calls[0]!.url).toBe(
      "https://api.example.com/search?q=hello+world&page=2",
    );
  });

  it("joins absolute paths verbatim", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })]);
    await client.request("GET", "https://other.example.com/foo");
    expect(calls[0]!.url).toBe("https://other.example.com/foo");
  });

  it("returns empty object on 204 No Content", async () => {
    const { client } = makeClient([mockResponse({ status: 204 })]);
    const r = await client.request("DELETE", "/x");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({});
      expect(r.status).toBe(204);
    }
  });

  it("sends JSON body and Content-Type when body is provided", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })]);
    await client.request("POST", "/x", { body: { a: 1 } });
    const init = calls[0]!.init;
    expect(init.body).toBe('{"a":1}');
    const h = init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("does not stringify string bodies", async () => {
    const { client, calls } = makeClient([mockResponse({ body: {} })]);
    await client.request("POST", "/x", { body: "raw-text" });
    expect(calls[0]!.init.body).toBe("raw-text");
  });
});

describe("HttpClient.request method allow-list", () => {
  it("rejects a method not in the allow-list", async () => {
    const { client } = makeClient([], {
      allowedMethods: new Set(["GET"]),
    });
    const r = await client.request("POST", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("METHOD_NOT_ALLOWED");
      expect(r.retriable).toBe(false);
    }
  });
});

describe("HttpClient.request URL validation", () => {
  it("rejects an invalid absolute URL", async () => {
    const { client } = makeClient([]);
    const r = await client.request("GET", "ftp://nope.example.com/file");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INVALID_URL");
      expect(r.retriable).toBe(false);
    }
  });
});

describe("HttpClient.request 4xx handling", () => {
  it("classifies 401 as UNAUTHORIZED with no retry", async () => {
    const { client, waits } = makeClient([
      mockResponse({ status: 401, body: { error: "no" } }),
    ]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNAUTHORIZED");
      expect(r.retriable).toBe(false);
      expect(r.status).toBe(401);
    }
    expect(waits).toHaveLength(0);
  });

  it("classifies 404 as NOT_FOUND", async () => {
    const { client } = makeClient([mockResponse({ status: 404 })]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("classifies 422 as UNPROCESSABLE", async () => {
    const { client } = makeClient([mockResponse({ status: 422 })]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNPROCESSABLE");
  });
});

describe("HttpClient.request 5xx retry", () => {
  it("retries 500 then returns the success", async () => {
    const { client, calls, waits } = makeClient([
      mockResponse({ status: 500 }),
      mockResponse({ body: { ok: true } }),
    ]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(30_000);
  });

  it("after MAX_ATTEMPTS 5xx still returns SERVER_ERROR", async () => {
    const { client, calls } = makeClient([
      mockResponse({ status: 500 }),
      mockResponse({ status: 502 }),
      mockResponse({ status: 503 }),
      mockResponse({ status: 504 }),
    ], { maxAttempts: 4 });
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SERVER_ERROR");
    expect(calls).toHaveLength(4);
  });
});

describe("HttpClient.request 429 retry + Retry-After", () => {
  it("retries 429 honoring Retry-After (seconds)", async () => {
    const { client, waits } = makeClient([
      mockResponse({ status: 429, headers: { "retry-after": "2" } }),
      mockResponse({ body: { ok: true } }),
    ]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(true);
    expect(waits[0]).toBe(2000);
  });

  it("retries 429 with exponential backoff when no Retry-After header", async () => {
    const { client, waits } = makeClient([
      mockResponse({ status: 429 }),
      mockResponse({ status: 429 }),
      mockResponse({ body: {} }),
    ]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(true);
    expect(waits).toEqual([500, 1000]);
  });

  it("emits RATE_LIMITED if 429 persists past max attempts", async () => {
    const { client } = makeClient([
      mockResponse({ status: 429 }),
      mockResponse({ status: 429 }),
      mockResponse({ status: 429 }),
      mockResponse({ status: 429 }),
    ], { maxAttempts: 4 });
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("RATE_LIMITED");
  });
});

describe("HttpClient.request shouldRetryResponse hook", () => {
  it("retries when shouldRetryResponse returns true for a non-429/non-5xx response", async () => {
    const { client, calls } = makeClient(
      [
        mockResponse({
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
        mockResponse({ body: { ok: true } }),
      ],
      {
        shouldRetryResponse: (r) =>
          r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0",
      },
    );
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("HttpClient.request binary responseType", () => {
  it("returns ArrayBuffer-backed bytes + filename from content-disposition", async () => {
    const buf = new TextEncoder().encode("PDF-CONTENT");
    const resp = mockResponse({
      body: buf,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report.pdf"',
      },
    });
    const { client } = makeClient([resp]);
    const r = await client.request<{ bytes: Uint8Array; filename?: string }>(
      "GET",
      "/dl/something",
      { responseType: "binary" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(r.data.bytes)).toBe("PDF-CONTENT");
      expect(r.data.filename).toBe("report.pdf");
    }
  });

  it("falls back to last path segment when content-disposition is absent", async () => {
    const buf = new TextEncoder().encode("X");
    const { client } = makeClient([
      mockResponse({ body: buf, headers: { "content-type": "text/plain" } }),
    ]);
    const r = await client.request<{ filename?: string }>(
      "GET",
      "/files/foo.txt",
      { responseType: "binary" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.filename).toBe("foo.txt");
  });
});

describe("HttpClient.request text responseType", () => {
  it("returns string body", async () => {
    const { client } = makeClient([
      mockResponse({ body: "raw\nbody", headers: { "content-type": "text/plain" } }),
    ]);
    const r = await client.request<string>("GET", "/x", { responseType: "text" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe("raw\nbody");
  });
});

describe("HttpClient.request network error", () => {
  it("retries on thrown fetch errors and surfaces NETWORK_ERROR if persistent", async () => {
    const { client, calls } = makeClient(() => {
      throw new Error("ECONNREFUSED");
    }, { maxAttempts: 2 });
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toMatch(/ECONNREFUSED/);
    }
    expect(calls).toHaveLength(2);
  });
});

describe("HttpClient.request rate-limit throttle", () => {
  it("throttles after rateLimitPerMin requests", async () => {
    const responses = Array.from({ length: 3 }, () =>
      mockResponse({ body: {} }),
    );
    const { client, waits } = makeClient(responses, {
      rateLimitPerMin: 2,
    });
    await client.request("GET", "/a");
    await client.request("GET", "/b");
    await client.request("GET", "/c"); // should trigger a throttle wait
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[waits.length - 1]).toBeGreaterThanOrEqual(0);
  });
});

describe("HttpClient.request error-body truncation", () => {
  it("truncates large error bodies in the surfaced message", async () => {
    const huge = "x".repeat(500);
    const { client } = makeClient([mockResponse({ status: 400, body: huge })]);
    const r = await client.request("GET", "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.length).toBeLessThan(huge.length + 60);
      expect(r.message).toContain("…");
    }
  });
});
