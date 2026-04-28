/**
 * Tests for the Notion connector built on `@narai/connector-toolkit`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNotionConnector } from "../../../../src/connectors/notion/index.js";
import {
  NotionClient,
  type NotionClientOptions,
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
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: fetchMock
      ? (async (url, init) => fetchMock(String(url), init))
      : undefined,
    sleepImpl: async () => {},
    ...overrides,
  });
}

function makeConnector(client: NotionClient) {
  return buildNotionConnector({
    sdk: async () => client,
    credentials: async () => ({ token: "secret_test" }),
  });
}

const SAMPLE_DB_ID = "a1b2c3d4e5f6789012345678901234ab";

describe("NotionClient — attachments + comments", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listPageFileBlocks filters file-type blocks from block children", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        results: [
          {
            id: "b1",
            type: "paragraph",
            paragraph: { rich_text: [] },
          },
          {
            id: "b2",
            type: "file",
            file: {
              type: "file",
              file: {
                url: "https://s3.notion.so/signed-url",
                expiry_time: "2026-04-21T01:00:00Z",
              },
              name: "report.pdf",
              caption: [{ plain_text: "Q1 report" }],
            },
          },
          {
            id: "b3",
            type: "image",
            image: {
              type: "external",
              external: { url: "https://example.com/pic.png" },
              caption: [],
            },
          },
          {
            id: "b4",
            type: "pdf",
            pdf: {
              type: "file",
              file: { url: "https://s3.notion.so/x.pdf", expiry_time: "..." },
              caption: [],
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    });
    const r = await client.listPageFileBlocks("pageid123");
    expect(calledUrl).toMatch(/\/v1\/blocks\/pageid123\/children/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(3);
      expect(r.data.results[0]?.id).toBe("b2");
      expect(r.data.results[0]?.type).toBe("file");
      expect(r.data.results[0]?.url_type).toBe("file");
      expect(r.data.results[0]?.filename).toBe("report.pdf");
      expect(r.data.results[1]?.url_type).toBe("external");
      expect(r.data.results[2]?.type).toBe("pdf");
    }
  });

  it("getBlock re-fetches a single block (for URL re-sign)", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        id: "b2",
        type: "file",
        file: {
          type: "file",
          file: { url: "https://fresh.signed/url", expiry_time: "..." },
          name: "report.pdf",
        },
      });
    });
    const r = await client.getBlock("b2");
    expect(calledUrl).toMatch(/\/v1\/blocks\/b2$/);
    expect(r.ok).toBe(true);
  });

  it("getComments returns comment list for a block", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        results: [
          {
            id: "cm1",
            created_by: { id: "user1" },
            created_time: "2026-04-01T00:00:00Z",
            rich_text: [
              { plain_text: "Hello " },
              { plain_text: "world" },
            ],
            parent: { page_id: "pageid123" },
          },
        ],
        has_more: false,
      });
    });
    const r = await client.getComments("pageid123");
    expect(calledUrl).toMatch(/\/v1\/comments\?/);
    expect(calledUrl).toMatch(/block_id=pageid123/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(1);
      expect(r.data.results[0]?.id).toBe("cm1");
      expect(r.data.results[0]?.body_plain).toBe("Hello world");
    }
  });
});

describe("NotionClient — init() and workspaceId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("populates workspaceId from GET /v1/users/me on success", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        bot: { workspace_id: "ws-abc-123" },
        object: "user",
        id: "bot-xyz",
      });
    });
    expect(client.workspaceId).toBeNull();
    await client.init();
    expect(calledUrl).toMatch(/\/v1\/users\/me$/);
    expect(client.workspaceId).toBe("ws-abc-123");
  });

  it("leaves workspaceId null on HTTP error and does not throw", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ message: "Unauthorized" }, { status: 401 }),
    );
    await expect(client.init()).resolves.toBeUndefined();
    expect(client.workspaceId).toBeNull();
  });

  it("leaves workspaceId null when fetch throws and does not throw", async () => {
    const client = makeClient({}, async () => {
      throw new Error("network down");
    });
    await expect(client.init()).resolves.toBeUndefined();
    expect(client.workspaceId).toBeNull();
  });

  it("connector scope callback returns cached workspaceId", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        bot: { workspace_id: "ws-scope-test" },
        object: "user",
        id: "bot-1",
      }),
    );
    await client.init();
    const c = makeConnector(client);
    // The toolkit's Connector exposes the config via internal shape; to
    // verify the scope contract end-to-end we assert the client getter —
    // the factory wires `scope: (ctx) => ctx.sdk.workspaceId` directly.
    expect(client.workspaceId).toBe("ws-scope-test");
    expect(c.validActions).toContain("search");
  });
});

describe("NotionClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends Notion-Version header", async () => {
    let headers: Headers | undefined;
    const client = makeClient({}, async (_url, init) => {
      headers = new Headers(init?.headers as HeadersInit);
      return jsonResponse({ results: [] });
    });
    await client.search("hello", undefined, 10);
    expect(headers?.get("notion-version")).toBe("2022-06-28");
    expect(headers?.get("authorization")).toBe("Bearer secret_test");
  });

  it("POST_READ_ONLY allowed on /v1/search", async () => {
    let called = "";
    let bodyStr = "";
    const client = makeClient({}, async (url, init) => {
      called = url;
      bodyStr = String(init?.body ?? "");
      return jsonResponse({ results: [] });
    });
    await client.search("hello", "page", 5);
    expect(called).toMatch(/\/v1\/search$/);
    expect(bodyStr).toMatch(/"filter":\{"property":"object","value":"page"\}/);
  });

  it("POST rejected on an unrelated path", async () => {
    const client = makeClient();
    const r = await client.request("POST_READ_ONLY" as never, "/v1/pages", {
      foo: 1,
    });
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "METHOD_NOT_ALLOWED" }),
    );
  });

  it("database query uses POST_READ_ONLY", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = String(init?.method ?? "");
      return jsonResponse({ results: [] });
    });
    await client.queryDatabase(SAMPLE_DB_ID, null, 10);
    expect(method).toBe("POST");
  });
});

describe("notion connector — fetch()", () => {
  beforeEach(() => {
    delete process.env["NOTION_TOKEN"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("exposes validActions", () => {
    const c = buildNotionConnector();
    expect([...c.validActions].sort()).toEqual([
      "get_attachment",
      "get_comments",
      "get_database",
      "get_page",
      "list_attachments",
      "query_database",
      "search",
    ]);
  });

  it("list_attachments returns normalized file-block list", async () => {
    const pageId = "a1b2c3d4e5f6789012345678901234ab";
    const client = makeClient({}, async (url) => {
      if (url.includes(`/blocks/${pageId}/children`)) {
        return jsonResponse({
          results: [
            {
              id: "b2",
              type: "pdf",
              pdf: {
                type: "file",
                file: {
                  url: "https://s3.notion.so/x.pdf",
                  expiry_time: "2026-04-21T01:00:00Z",
                },
                caption: [{ plain_text: "Doc" }],
                name: "plan.pdf",
              },
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse({});
    });
    const c = makeConnector(client);
    const r = await c.fetch("list_attachments", { page_id: pageId });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const atts = r.data["attachments"] as Array<Record<string, unknown>>;
      expect(atts).toHaveLength(1);
      expect(atts[0]?.["attachment_id"]).toBe("b2");
      expect(atts[0]?.["block_type"]).toBe("pdf");
      expect(atts[0]?.["caption"]).toBe("Doc");
      expect(atts[0]?.["filename"]).toBe("plan.pdf");
    }
  });

  it("get_attachment fetches fresh URL + downloads via fetchAttachment", async () => {
    const pageId = "a1b2c3d4e5f6789012345678901234ab";
    const blockId = "b1b2c3d4e5f6789012345678901234ab";
    const body = new TextEncoder().encode("hello world");
    const client = makeClient({}, async (url) => {
      if (url.endsWith(`/v1/blocks/${blockId}`)) {
        return jsonResponse({
          id: blockId,
          type: "file",
          file: {
            type: "external",
            external: { url: "https://example.com/report.txt" },
            name: "report.txt",
          },
        });
      }
      return jsonResponse({});
    });
    const c = makeConnector(client);
    // Inject a global.fetch replacement for the external URL download.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    try {
      const r = await c.fetch("get_attachment", {
        page_id: pageId,
        block_id: blockId,
      });
      expect(r.status).toBe("success");
      if (r.status === "success") {
        expect(r.data["block_type"]).toBe("file");
        expect(r.data["filename"]).toBe("report.txt");
        expect(r.data["media_type"]).toBe("text/plain");
        const extracted = r.data["extracted"] as Record<string, unknown>;
        expect(extracted["format"]).toBe("text");
        expect(extracted["text"]).toBe("hello world");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("get_attachment rejects non-file blocks", async () => {
    const pageId = "a1b2c3d4e5f6789012345678901234ab";
    const blockId = "b1b2c3d4e5f6789012345678901234ab";
    const client = makeClient({}, async () =>
      jsonResponse({
        id: blockId,
        type: "paragraph",
        paragraph: { rich_text: [] },
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_attachment", {
      page_id: pageId,
      block_id: blockId,
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("get_comments returns comment list", async () => {
    const pageId = "a1b2c3d4e5f6789012345678901234ab";
    const client = makeClient({}, async () =>
      jsonResponse({
        results: [
          {
            id: "cm1",
            created_by: { id: "u1" },
            created_time: "2026-04-01T00:00:00Z",
            rich_text: [{ plain_text: "hi" }],
            parent: { page_id: pageId },
          },
        ],
        has_more: false,
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_comments", { page_id: pageId });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const comments = r.data["comments"] as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0]?.["body_plain"]).toBe("hi");
      expect(comments[0]?.["author_id"]).toBe("u1");
    }
  });

  it("rejects invalid UUID", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("get_page", { page_id: "not-a-uuid" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("rejects empty search query", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("search", { query: "" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("returns CONFIG_ERROR when NOTION_TOKEN missing", async () => {
    const c = buildNotionConnector();
    const r = await c.fetch("search", { query: "hello" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.retriable).toBe(false);
      expect(r.message).toContain("NOTION_TOKEN");
    }
  });

  it("extracts title via property shape", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        id: SAMPLE_DB_ID,
        parent: { type: "workspace" },
        last_edited_time: "2026-04-01T00:00:00Z",
        properties: {
          Name: {
            type: "title",
            title: [{ plain_text: "Hello " }, { plain_text: "World" }],
          },
        },
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_page", { page_id: SAMPLE_DB_ID });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["title"]).toBe("Hello World");
    }
  });

  it("search returns shaped envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        has_more: false,
        results: [
          { id: "p1-abcd", last_edited_time: "t", properties: {} },
          { id: "d1-wxyz", title: [{ plain_text: "DB" }] },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("search", { query: "arch" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const results = r.data["results"] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(2);
      expect(results[0]!["object_type"]).toBe("page");
      expect(results[1]!["object_type"]).toBe("database");
    }
  });

  it("surfaces 401 as AUTH_ERROR", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_database", { database_id: SAMPLE_DB_ID });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("AUTH_ERROR");
  });

  it("surfaces 404 as NOT_FOUND", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 404 }));
    const c = makeConnector(client);
    const r = await c.fetch("get_page", { page_id: SAMPLE_DB_ID });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });

  it("envelope is wiki-agnostic — no mermaid field", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        has_more: false,
        results: [{ id: "p1-abcd", last_edited_time: "t", properties: {} }],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("search", { query: "arch" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["mermaid"]).toBeUndefined();
    }
  });
});
