/**
 * Tests for the Confluence connector built on `@narai/connector-toolkit`.
 *
 * The factory pattern changes the injection shape: each test builds its
 * own connector via `buildConfluenceConnector({ sdk: async () => fakeClient })`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
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
      "PATCH" as never,
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
      "add_comment",
      "cql_search",
      "create_page",
      "delete_page",
      "get_attachment",
      "get_comments",
      "get_page",
      "get_space",
      "list_attachments",
      "post_attachment",
      "update_page",
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

// ─── Write-action tests ───────────────────────────────────────────────────────
//
// HTTP-shape coverage done directly via ConfluenceClient (no policy gate).
// Connector-level tests use a connector built with write: "success" to reach
// the handler without an escalate envelope.

function makeWriteConnector(client: ConfluenceClient) {
  return buildConfluenceConnector({
    sdk: async () => client,
    credentials: async () => ({ email: "user@example.com" }),
    defaultPolicy: { read: "success", write: "success", admin: "denied" },
  });
}

describe("ConfluenceClient — write methods", () => {
  afterEach(() => vi.restoreAllMocks());

  it("createPage sends POST with JSON body and Content-Type: application/json", async () => {
    let method = "";
    let capturedHeaders: Headers | null = null;
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      sentBody = init?.body as string;
      return jsonResponse(
        { id: "123", title: "My Page", version: { number: 1 } },
        { status: 200 },
      );
    });
    const r = await client.createPage({
      type: "page",
      title: "My Page",
      space: { key: "DEV" },
      body: {
        atlas_doc_format: {
          value: JSON.stringify({ type: "doc", version: 1, content: [] }),
          representation: "atlas_doc_format",
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(method).toBe("POST");
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");
    const parsed = JSON.parse(sentBody);
    expect(parsed.body.atlas_doc_format.representation).toBe("atlas_doc_format");
  });

  it("updatePage sends PUT and returns updated content", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return jsonResponse(
        { id: "123", title: "Updated", version: { number: 2 } },
        { status: 200 },
      );
    });
    const r = await client.updatePage("123", { type: "page", title: "Updated", version: { number: 2 } });
    expect(r.ok).toBe(true);
    expect(method).toBe("PUT");
  });

  it("deletePage sends DELETE and handles 204", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    const r = await client.deletePage("123");
    expect(r.ok).toBe(true);
    expect(method).toBe("DELETE");
  });

  it("addComment sends POST with JSON body", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return jsonResponse(
        { id: "c1", history: { createdDate: "2026-01-01", createdBy: { displayName: "Alice" } } },
        { status: 200 },
      );
    });
    const r = await client.addComment({
      type: "comment",
      container: { id: "123", type: "page" },
      body: {
        atlas_doc_format: {
          value: JSON.stringify({ type: "doc", version: 1, content: [] }),
          representation: "atlas_doc_format",
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(method).toBe("POST");
  });

  it("postAttachment sends multipart without explicit Content-Type, with X-Atlassian-Token", async () => {
    let capturedHeaders: Headers | null = null;
    let capturedBody: unknown = null;
    const client = makeClient({}, async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      capturedBody = init?.body;
      return jsonResponse(
        { results: [{ id: "att1", title: "hello.txt", metadata: { mediaType: "text/plain" }, extensions: { fileSize: 5 } }] },
        { status: 200 },
      );
    });
    const r = await client.postAttachment("123", [
      { filename: "hello.txt", bytes: new Uint8Array([104, 101, 108, 108, 111]) },
    ]);
    expect(r.ok).toBe(true);
    // X-Atlassian-Token must be present
    expect(capturedHeaders!.get("X-Atlassian-Token")).toBe("no-check");
    // Content-Type must NOT be explicitly set (let fetch set the boundary)
    expect(capturedHeaders!.get("Content-Type")).toBeNull();
    // Body must be a FormData instance
    expect(capturedBody).toBeInstanceOf(FormData);
  });
});

describe("confluence connector — write actions (write: success policy)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("create_page happy path: atlas_doc_format representation, value is JSON-stringified ADF", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return jsonResponse(
        { id: "999", title: "New Page", version: { number: 1 } },
        { status: 200 },
      );
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("create_page", {
      space_key: "DEV",
      title: "New Page",
      body: { format: "plain", value: "Hello world" },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["id"]).toBe("999");
      expect(r.data["title"]).toBe("New Page");
    }
    const parsed = JSON.parse(sentBody);
    expect(parsed.body.atlas_doc_format.representation).toBe("atlas_doc_format");
    // value must be a JSON-stringified string (not a nested object)
    expect(typeof parsed.body.atlas_doc_format.value).toBe("string");
    const adf = JSON.parse(parsed.body.atlas_doc_format.value as string);
    expect(adf.type).toBe("doc");
    expect(adf.version).toBe(1);
  });

  it("create_page markdown conversion: ADF has heading node containing text 'Hi'", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return jsonResponse(
        { id: "1000", title: "Md Page", version: { number: 1 } },
        { status: 200 },
      );
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("create_page", {
      space_key: "DEV",
      title: "Md Page",
      body: { format: "markdown", value: "# Hi" },
    });
    expect(r.status).toBe("success");
    const parsed = JSON.parse(sentBody);
    const adf = JSON.parse(parsed.body.atlas_doc_format.value as string);
    // The converted ADF should have at least one heading node
    const headings = adf.content.filter((n: { type: string }) => n.type === "heading");
    expect(headings.length).toBeGreaterThan(0);
    // The heading node should contain text "Hi"
    const allText = headings
      .flatMap((h: { content?: Array<{ type: string; text?: string }> }) =>
        (h.content ?? []).filter((n) => n.type === "text").map((n) => n.text ?? ""),
      )
      .join("");
    expect(allText).toContain("Hi");
  });

  it("create_page ADF validation rejection: invalid root → VALIDATION_ERROR", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ id: "x" }, { status: 200 }),
    );
    const c = makeWriteConnector(client);
    const r = await c.fetch("create_page", {
      space_key: "DEV",
      title: "Bad",
      body: { format: "adf", value: { type: "paragraph" } }, // missing doc root
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("update_page happy path: version.number === expected_version + 1", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return jsonResponse(
        { id: "42", title: "Updated", version: { number: 6 } },
        { status: 200 },
      );
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("update_page", {
      page_id: "42",
      title: "Updated",
      body: { format: "plain", value: "new content" },
      expected_version: 5,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["id"]).toBe("42");
      expect(r.data["version"]).toBe(6);
      expect(r.data["updated"]).toBe(true);
    }
    const parsed = JSON.parse(sentBody);
    expect(parsed.version.number).toBe(6); // expected_version (5) + 1
  });

  it("delete_page happy path: returns {id, deleted: true}", async () => {
    const client = makeClient({}, async () => new Response(null, { status: 204 }));
    const c = makeWriteConnector(client);
    const r = await c.fetch("delete_page", { page_id: "77" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["id"]).toBe("77");
      expect(r.data["deleted"]).toBe(true);
    }
  });

  it("add_comment happy path: type=comment, container.id matches page_id", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return jsonResponse(
        {
          id: "c99",
          history: { createdDate: "2026-05-01T00:00:00Z", createdBy: { displayName: "Alice" } },
        },
        { status: 200 },
      );
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("add_comment", {
      page_id: "123",
      body: { format: "plain", value: "Nice page!" },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["comment_id"]).toBe("c99");
      expect(r.data["author"]).toBe("Alice");
    }
    const parsed = JSON.parse(sentBody);
    expect(parsed.type).toBe("comment");
    expect(parsed.container.id).toBe("123");
  });

  it("post_attachment (base64): no Content-Type, X-Atlassian-Token: no-check, FormData body", async () => {
    let capturedHeaders: Headers | null = null;
    let capturedBody: unknown = null;
    const client = makeClient({}, async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      capturedBody = init?.body;
      return jsonResponse(
        {
          results: [
            { id: "att1", title: "doc.txt", metadata: { mediaType: "text/plain" }, extensions: { fileSize: 3 } },
          ],
        },
        { status: 200 },
      );
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("post_attachment", {
      page_id: "123",
      files: [
        {
          filename: "doc.txt",
          content_base64: Buffer.from("hi!").toString("base64"),
          mime_type: "text/plain",
        },
      ],
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["page_id"]).toBe("123");
      const atts = r.data["attachments"] as Array<Record<string, unknown>>;
      expect(atts).toHaveLength(1);
      expect(atts[0]?.["id"]).toBe("att1");
    }
    expect(capturedHeaders!.get("X-Atlassian-Token")).toBe("no-check");
    expect(capturedHeaders!.get("Content-Type")).toBeNull();
    expect(capturedBody).toBeInstanceOf(FormData);
  });

  it("post_attachment (path): writes tmp file inside CWD, upload succeeds, no Content-Type", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-conf-test-"));
    const tmpFile = path.join(tmpDir, "note.txt");
    fs.writeFileSync(tmpFile, "test");
    let capturedHeaders: Headers | null = null;
    let capturedBody: unknown = null;
    try {
      const client = makeClient({}, async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body;
        return jsonResponse(
          {
            results: [
              { id: "att2", title: "note.txt", metadata: { mediaType: "text/plain" }, extensions: { fileSize: 4 } },
            ],
          },
          { status: 200 },
        );
      });
      const c = makeWriteConnector(client);
      const r = await c.fetch("post_attachment", {
        page_id: "123",
        files: [{ path: tmpFile, mime_type: "text/plain" }],
      });
      expect(r.status).toBe("success");
      expect(capturedHeaders!.get("X-Atlassian-Token")).toBe("no-check");
      expect(capturedHeaders!.get("Content-Type")).toBeNull();
      expect(capturedBody).toBeInstanceOf(FormData);
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it("post_attachment (path escape): /etc/passwd → VALIDATION_ERROR, sdk never called", async () => {
    let sdkCalled = false;
    const client = makeClient({}, async () => {
      sdkCalled = true;
      return jsonResponse({ results: [] }, { status: 200 });
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("post_attachment", {
      page_id: "123",
      files: [{ path: "/etc/passwd" }],
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
    expect(sdkCalled).toBe(false);
  });
});
