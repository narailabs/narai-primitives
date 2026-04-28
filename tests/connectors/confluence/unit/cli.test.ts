/**
 * Tests for the Confluence connector built on `@narai/connector-toolkit`.
 *
 * The factory pattern changes the injection shape: each test builds its
 * own connector via `buildConfluenceConnector({ sdk: async () => fakeClient })`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfluenceConnector } from "../../../../src/connectors/confluence/index.js";
import {
  ConfluenceClient,
  type ConfluenceClientOptions,
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
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: fetchMock
      ? (async (url, init) => fetchMock(String(url), init))
      : undefined,
    sleepImpl: async () => {},
    ...overrides,
  });
}

function makeConnector(client: ConfluenceClient) {
  return buildConfluenceConnector({
    sdk: async () => client,
    credentials: async () => ({ email: "user@example.com" }),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// ConfluenceClient — unchanged from v1, kept for parity with old coverage.
// ───────────────────────────────────────────────────────────────────────────

describe("ConfluenceClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attaches Basic auth header", async () => {
    let headers: Headers | undefined;
    const client = makeClient({}, async (_url, init) => {
      headers = new Headers(init?.headers as HeadersInit);
      return jsonResponse({ results: [], totalSize: 0 });
    });
    await client.searchCql("space = DEV", 10);
    expect(headers?.get("authorization")).toMatch(/^Basic /);
  });

  it("expands body.storage on getContent by default", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        id: "1",
        title: "t",
        body: { storage: { value: "<p>hi</p>" } },
        space: { key: "DEV" },
        version: { number: 3 },
      });
    });
    const res = await client.getContent("1");
    expect(calledUrl).toMatch(/expand=body\.storage/);
    expect(res.ok).toBe(true);
  });

  it("rejects unknown HTTP methods", async () => {
    const client = makeClient();
    const res = await client.request(
      "DELETE" as never,
      "/wiki/rest/api/space/DEV",
    );
    expect(res).toEqual(
      expect.objectContaining({ ok: false, code: "METHOD_NOT_ALLOWED" }),
    );
  });

  it("retries on 503 and surfaces final error after retries exhausted", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      return jsonResponse({}, { status: 503 });
    });
    const res = await client.searchCql("x", 10);
    expect(calls).toBe(4);
    expect(res.ok).toBe(false);
  });

  it("getAttachmentDownload returns raw bytes and derived filename", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const client = makeClient({}, async () => {
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="hello.pdf"',
        },
      });
    });
    const r = await client.getAttachmentDownload(
      "/download/attachments/123/hello.pdf",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.contentType).toBe("application/pdf");
      expect(r.data.filename).toBe("hello.pdf");
      expect(Array.from(r.data.bytes)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("getAttachmentDownload surfaces 404 as an error envelope", async () => {
    const client = makeClient({}, async () => new Response("", { status: 404 }));
    const r = await client.getAttachmentDownload("/download/attachments/9/x.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("getAttachmentDownload falls back to URL basename when content-disposition missing", async () => {
    const client = makeClient({}, async () =>
      new Response(new Uint8Array([0]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await client.getAttachmentDownload(
      "/download/attachments/123/file%20with%20spaces.bin",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.filename).toBe("file with spaces.bin");
  });

  it("getComments returns normalized comments with plain-text body", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        results: [
          {
            id: "c1",
            history: {
              createdBy: { displayName: "Alice" },
              createdDate: "2026-04-01T00:00:00Z",
            },
            version: { number: 2 },
            body: {
              view: {
                value: "<p>First <b>line</b></p><p>Second line</p>",
              },
            },
          },
          {
            id: "c2",
            history: {
              createdBy: { displayName: "Bob" },
              createdDate: "2026-04-02T00:00:00Z",
            },
            version: { number: 1 },
            body: { view: { value: "no html here" } },
          },
        ],
        size: 2,
      });
    });
    const r = await client.getComments("123", 50);
    expect(calledUrl).toMatch(
      /\/wiki\/rest\/api\/content\/123\/child\/comment\?/,
    );
    expect(calledUrl).toMatch(/limit=50/);
    expect(calledUrl).toMatch(/expand=/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(2);
      expect(r.data.results[0]?.id).toBe("c1");
      expect(r.data.results[0]?.author).toBe("Alice");
      expect(r.data.results[0]?.created).toBe("2026-04-01T00:00:00Z");
      expect(r.data.results[0]?.version).toBe(2);
      expect(r.data.results[0]?.body_plain).toBe("First line\n\nSecond line");
      expect(r.data.results[1]?.body_plain).toBe("no html here");
    }
  });

  it("listAttachments returns attachment list for a page", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        results: [
          {
            id: "att1",
            title: "doc.pdf",
            metadata: { mediaType: "application/pdf" },
            extensions: { fileSize: 1234 },
            version: { number: 1 },
            _links: { download: "/download/attachments/123/doc.pdf" },
          },
        ],
        size: 1,
        start: 0,
        limit: 25,
      });
    });
    const r = await client.listAttachments("123", 25);
    expect(calledUrl).toMatch(
      /\/wiki\/rest\/api\/content\/123\/child\/attachment\?/,
    );
    expect(calledUrl).toMatch(/limit=25/);
    expect(calledUrl).toMatch(/start=0/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(1);
      expect(r.data.results[0]?.id).toBe("att1");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Connector fetch — happy paths and error mapping.
// ───────────────────────────────────────────────────────────────────────────

describe("confluence connector — fetch()", () => {
  beforeEach(() => {
    delete process.env["CONFLUENCE_SITE_URL"];
    delete process.env["CONFLUENCE_EMAIL"];
    delete process.env["CONFLUENCE_API_TOKEN"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("exposes validActions", () => {
    const c = buildConfluenceConnector();
    expect([...c.validActions].sort()).toEqual([
      "cql_search",
      "get_attachment",
      "get_comments",
      "get_page",
      "get_space",
      "list_attachments",
    ]);
  });

  it("rejects unknown action with VALIDATION_ERROR", async () => {
    const c = buildConfluenceConnector({
      sdk: async () => makeClient(),
      credentials: async () => ({}),
    });
    const r = await c.fetch("nope", {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("validates page_id format", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("get_page", { page_id: "not-numeric" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("validates space_key format", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("get_space", { space_key: "lower" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("requires non-empty cql", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("cql_search", { cql: "" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("returns CONFIG_ERROR when credentials missing", async () => {
    // Default sdk() loads creds — with no env, it throws ConfluenceError.
    const c = buildConfluenceConnector();
    const r = await c.fetch("get_space", { space_key: "DEV" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.retriable).toBe(false);
      expect(r.message).toContain("CONFLUENCE_");
    }
  });

  it("reshapes cql_search into data envelope with injected client", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        totalSize: 1,
        size: 1,
        results: [
          {
            id: "42",
            title: "Hello",
            space: { key: "DEV" },
            version: { number: 2, when: "2026-04-01T00:00:00Z" },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("cql_search", { cql: "space = DEV", max_results: 5 });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["total"]).toBe(1);
      const pages = r.data["pages"] as Array<Record<string, unknown>>;
      expect(pages[0]?.["title"]).toBe("Hello");
    }
  });

  it("get_page returns a success envelope with shaped fields", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        id: "123",
        title: "Arch doc",
        space: { key: "DEV" },
        version: { number: 4, when: "2026-04-10T00:00:00Z" },
        body: { storage: { value: "# Hello" } },
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_page", { page_id: "123" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["title"]).toBe("Arch doc");
      expect(r.data["body_markdown"]).toBe("# Hello");
      expect(r.data["version"]).toBe(4);
    }
  });

  it("get_space returns a success envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        key: "DEV",
        name: "Dev Space",
        type: "global",
        description: { plain: { value: "dev docs" } },
        homepage: { id: "1" },
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_space", { space_key: "DEV" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["name"]).toBe("Dev Space");
      expect(r.data["homepage_id"]).toBe("1");
    }
  });

  it("surfaces 401 as AUTH_ERROR", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 401 }));
    const c = makeConnector(client);
    const r = await c.fetch("get_page", { page_id: "123" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("AUTH_ERROR");
      expect(r.retriable).toBe(false);
    }
  });

  it("surfaces 404 as NOT_FOUND", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 404 }));
    const c = makeConnector(client);
    const r = await c.fetch("get_page", { page_id: "999" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });

  it("surfaces 429 as RATE_LIMITED with retriable=true", async () => {
    // Client retries 4x on 429; we return 429 every time. Final envelope.
    const client = makeClient({}, async () => jsonResponse({}, { status: 429 }));
    const c = makeConnector(client);
    const r = await c.fetch("cql_search", { cql: "x" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("RATE_LIMITED");
      expect(r.retriable).toBe(true);
    }
  });

  it("list_attachments action returns normalized list", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        size: 1,
        start: 0,
        limit: 25,
        results: [
          {
            id: "att1",
            title: "doc.pdf",
            metadata: { mediaType: "application/pdf" },
            extensions: { fileSize: 1234 },
            version: { number: 1, when: "2026-04-10T00:00:00Z" },
            _links: { download: "/download/attachments/123/doc.pdf" },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("list_attachments", { page_id: "123" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const attachments = r.data["attachments"] as Array<
        Record<string, unknown>
      >;
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.["attachment_id"]).toBe("att1");
      expect(attachments[0]?.["filename"]).toBe("doc.pdf");
      expect(attachments[0]?.["media_type"]).toBe("application/pdf");
      expect(attachments[0]?.["size_bytes"]).toBe(1234);
    }
  });

  it("get_attachment action fetches + extracts", async () => {
    let callCount = 0;
    const pdfBody = new TextEncoder().encode("NOT_REAL_PDF");
    const client = makeClient({}, async (url) => {
      callCount++;
      if (url.includes("/child/attachment")) {
        return jsonResponse({
          size: 1,
          results: [
            {
              id: "att1",
              title: "a.pdf",
              metadata: { mediaType: "application/pdf" },
              extensions: { fileSize: pdfBody.byteLength },
              _links: { download: "/download/attachments/123/a.pdf" },
            },
          ],
        });
      }
      return new Response(pdfBody, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="a.pdf"',
        },
      });
    });
    const c = makeConnector(client);
    const r = await c.fetch("get_attachment", {
      page_id: "123",
      attachment_id: "att1",
    });
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["attachment_id"]).toBe("att1");
      expect(r.data["filename"]).toBe("a.pdf");
      expect(r.data["media_type"]).toBe("application/pdf");
      expect(typeof r.data["checksum"]).toBe("string");
      expect((r.data["checksum"] as string)).toHaveLength(64);
      const extracted = r.data["extracted"] as Record<string, unknown>;
      // With no pdfjs-dist installed, extraction should skip cleanly.
      expect(["pdf", "skipped"]).toContain(extracted["format"]);
    }
  });

  it("get_attachment returns NOT_FOUND for unknown attachment_id", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ size: 0, results: [] }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_attachment", {
      page_id: "123",
      attachment_id: "nope",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });

  it("get_comments action returns comment list", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        size: 1,
        results: [
          {
            id: "c1",
            history: {
              createdBy: { displayName: "Alice" },
              createdDate: "2026-04-01T00:00:00Z",
            },
            version: { number: 1 },
            body: { view: { value: "<p>hi</p>" } },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_comments", { page_id: "123" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const comments = r.data["comments"] as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0]?.["author"]).toBe("Alice");
      expect(comments[0]?.["body_plain"]).toBe("hi");
    }
  });

  it("envelope is wiki-agnostic — no mermaid field in success path", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        totalSize: 1,
        size: 1,
        results: [
          {
            id: "1",
            title: "Architecture",
            space: { key: "DEV" },
            version: { number: 1 },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("cql_search", { cql: "space = DEV" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["mermaid"]).toBeUndefined();
    }
  });
});
