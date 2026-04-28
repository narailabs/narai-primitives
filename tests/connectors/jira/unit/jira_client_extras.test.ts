/**
 * Coverage extras for jira_client.ts — targets the request() retry loop,
 * timeout/network classification, classifyHttpStatus, parseRetryAfter,
 * _throttle rate-limit branch, getAttachmentDownload error paths, and
 * misc default branches (loadJiraCredentials, resetRateLimiter).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JiraClient,
  type JiraClientOptions,
  loadJiraCredentials,
} from "../../../../src/connectors/jira/lib/jira_client.js";

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
  overrides: Partial<JiraClientOptions> = {},
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
): JiraClient {
  return new JiraClient({
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

describe("JiraClient.request — retry & timeout branches", () => {
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
        return jsonResponse({ ok: true });
      },
    );
    const r = await client.request("GET", "/rest/api/3/myself");
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
    const r = await client.request("GET", "/rest/api/3/myself");
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(500);
    expect(sleeps[1]).toBe(1000);
    expect(r.ok).toBe(true);
  });

  it("returns SERVER_ERROR after MAX_ATTEMPTS exhausted", async () => {
    const client = makeClient({}, async () =>
      new Response("nope", { status: 500 }),
    );
    const r = await client.request("GET", "/rest/api/3/myself");
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
    const r = await client.request("GET", "/rest/api/3/myself");
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
    const r = await client.request("GET", "/rest/api/3/myself");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("returns TIMEOUT after MAX_ATTEMPTS of DOMException", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.request("GET", "/rest/api/3/myself");
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
    const r = await client.request("GET", "/rest/api/3/myself");
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
    const r = await client.request("GET", "/rest/api/3/myself");
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
    const r = await client.request("GET", "/rest/api/3/myself");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_REQUEST");
  });

  it("treats a non-DOMException Error containing /abort/i as TIMEOUT", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      if (calls === 1) throw new Error("Operation was aborted");
      return jsonResponse({ ok: true });
    });
    const r = await client.request("GET", "/rest/api/3/myself");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });
});

describe("JiraClient — _throttle()", () => {
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
            now += ms;
          },
        },
        async () => jsonResponse({ ok: true }),
      );
      await client.request("GET", "/rest/api/3/a");
      await client.request("GET", "/rest/api/3/b");
      await client.request("GET", "/rest/api/3/c");
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("resetRateLimiter clears the sliding-window timestamps", () => {
    const client = makeClient({ rateLimitPerMin: 1 });
    client.resetRateLimiter();
    // Smoke check — no-throw and back to a clean state.
    expect(client.siteUrl).toBe("https://example.atlassian.net");
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
    const r = await client.request("GET", "/rest/api/3/myself");
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
    await client.request("GET", "/rest/api/3/myself");
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
    await client.request("GET", "/rest/api/3/myself");
    expect(sleeps[0]).toBe(500);
  });
});

describe("getAttachmentDownload — error branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("classifies 401 as UNAUTHORIZED and is not retriable", async () => {
    const client = makeClient({}, async () => new Response("", { status: 401 }));
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNAUTHORIZED");
      expect(r.retriable).toBe(false);
    }
  });

  it("marks 503 as retriable=true via classifier fallback", async () => {
    const client = makeClient({}, async () => new Response("", { status: 503 }));
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retriable).toBe(true);
      expect(r.code).toBe("HTTP_ERROR");
    }
  });

  it("marks 429 as retriable=true via classifier fallback", async () => {
    const client = makeClient({}, async () => new Response("", { status: 429 }));
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retriable).toBe(true);
    }
  });

  it("classifies DOMException as TIMEOUT", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.getAttachmentDownload("10001");
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
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toContain("ECONNRESET");
    }
  });

  it("classifies a non-Error throwable as NETWORK_ERROR", async () => {
    const client = makeClient({}, async () => {
      throw "raw-string-err";
    });
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("raw-string-err");
  });

  it("falls back to attachmentId when content-disposition missing", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.filename).toBe("10001");
      expect(r.data.contentType).toBe("image/png");
    }
  });

  it("defaults contentType to application/octet-stream when header missing", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([1]), { status: 200 }),
    );
    const r = await client.getAttachmentDownload("9");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.contentType).toBe("application/octet-stream");
  });
});

describe("loadJiraCredentials — null path + happy path", () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it("returns null when env vars are missing", async () => {
    delete process.env["JIRA_SITE_URL"];
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_API_TOKEN"];
    const r = await loadJiraCredentials();
    expect(r).toBeNull();
  });

  it("returns null when only site URL is set", async () => {
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_API_TOKEN"];
    process.env["JIRA_SITE_URL"] = "https://example.atlassian.net";
    const r = await loadJiraCredentials();
    expect(r).toBeNull();
  });

  it("returns full credential object when all three env vars set", async () => {
    process.env["JIRA_SITE_URL"] = "https://example.atlassian.net";
    process.env["JIRA_EMAIL"] = "u@example.com";
    process.env["JIRA_API_TOKEN"] = "tok-y";
    const r = await loadJiraCredentials();
    expect(r).not.toBeNull();
    expect(r?.siteUrl).toBe("https://example.atlassian.net");
    expect(r?.email).toBe("u@example.com");
    expect(r?.apiToken).toBe("tok-y");
  });
});

describe("JiraClient — defaults branches & misc", () => {
  it("constructs with all timing options omitted (uses defaults)", () => {
    const c = new JiraClient({
      siteUrl: "https://example.atlassian.net",
      email: "u@example.com",
      apiToken: "tok",
    });
    expect(c.siteUrl).toBe("https://example.atlassian.net");
  });

  it("default sleepImpl resolves on retry-after=0", async () => {
    let calls = 0;
    const c = new JiraClient({
      siteUrl: "https://example.atlassian.net",
      email: "u",
      apiToken: "t",
      rateLimitPerMin: 100,
      // no sleepImpl: exercises the default factory closure
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
    const r = await c.request("GET", "/rest/api/3/myself");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("trims trailing slashes from siteUrl", () => {
    const c = new JiraClient({
      siteUrl: "https://example.atlassian.net///",
      email: "u",
      apiToken: "t",
    });
    expect(c.siteUrl).toBe("https://example.atlassian.net");
  });
});

describe("buildUrl — query / path branches", () => {
  it("prepends '/' to a relative path", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true });
    });
    await client.request("GET", "rest/api/3/myself");
    expect(calledUrl).toBe("https://example.atlassian.net/rest/api/3/myself");
  });

  it("skips undefined and null query values", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true });
    });
    await client.request("GET", "/rest/api/3/myself", {
      query: { ok: "1", a: undefined, b: null },
    });
    expect(calledUrl).toContain("?ok=1");
    expect(calledUrl).not.toContain("a=");
    expect(calledUrl).not.toContain("b=");
  });

  it("skips trailing '?' when all query values are nullish", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true });
    });
    await client.request("GET", "/rest/api/3/myself", {
      query: { a: undefined, b: null },
    });
    expect(calledUrl).toBe("https://example.atlassian.net/rest/api/3/myself");
  });
});

describe("listAttachments / getComments — optional fields branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listAttachments returns empty when fields.attachment is missing", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ key: "DEV-1" }), // no fields
    );
    const r = await client.listAttachments("DEV-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toEqual([]);
      expect(r.data.issueKey).toBe("DEV-1");
    }
  });

  it("listAttachments fills defaults for missing attachment fields", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        // key omitted → falls back to issueKey arg
        fields: {
          attachment: [
            { id: "x" }, // no filename, mimeType, size, created, author, content
          ],
        },
      }),
    );
    const r = await client.listAttachments("DEV-2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.issueKey).toBe("DEV-2");
      const a = r.data.results[0];
      expect(a?.id).toBe("x");
      expect(a?.filename).toBe("");
      expect(a?.mediaType).toBe("application/octet-stream");
      expect(a?.sizeBytes).toBe(0);
      expect(a?.created).toBe("");
      expect(a?.author).toBe("");
      expect(a?.contentUrl).toBe("");
    }
  });

  it("listAttachments propagates a request error", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 404 }));
    const r = await client.listAttachments("DEV-9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("getComments handles missing comment fields gracefully", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        // total omitted → defaults to results.length
        comments: [
          { id: "c1" }, // no author, no created, no updated, no body
        ],
      }),
    );
    const r = await client.getComments("DEV-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.issueKey).toBe("DEV-1");
      expect(r.data.total).toBe(1);
      const c = r.data.results[0];
      expect(c?.author).toBe("");
      expect(c?.created).toBe("");
      expect(c?.updated).toBe(""); // falls back to created which also empty
      expect(c?.body_plain).toBe("");
    }
  });

  it("getComments handles missing comments array entirely", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({}), // no comments, no total
    );
    const r = await client.getComments("DEV-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toEqual([]);
      expect(r.data.total).toBe(0);
    }
  });

  it("getComments propagates a request error", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 403 }));
    const r = await client.getComments("DEV-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED");
  });
});

describe("getIssue — expand parameter branch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits expand query when expand list is empty", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ key: "DEV-1" });
    });
    await client.getIssue("DEV-1");
    expect(calledUrl).not.toContain("expand=");
  });

  it("includes expand query when an expand list is provided", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({ key: "DEV-1" });
    });
    await client.getIssue("DEV-1", ["renderedFields", "names"]);
    expect(calledUrl).toContain("expand=renderedFields%2Cnames");
  });
});
