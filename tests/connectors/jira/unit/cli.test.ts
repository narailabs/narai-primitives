/**
 * Tests for the Jira connector built on `@narai/connector-toolkit`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildJiraConnector } from "../../../../src/connectors/jira/index.js";
import {
  JiraClient,
  type JiraClientOptions,
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
  const opts: JiraClientOptions = {
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
  };
  return new JiraClient(opts);
}

function makeConnector(client: JiraClient) {
  return buildJiraConnector({
    sdk: async () => client,
    credentials: async () => ({ email: "user@example.com" }),
  });
}

describe("JiraClient — attachments + comments", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listAttachments reads fields.attachment via the issue endpoint", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        key: "DEV-42",
        fields: {
          attachment: [
            {
              id: "10001",
              filename: "report.pdf",
              mimeType: "application/pdf",
              size: 1234,
              created: "2026-04-01T00:00:00Z",
              author: { displayName: "Alice" },
              content:
                "https://example.atlassian.net/rest/api/3/attachment/content/10001",
            },
          ],
        },
      });
    });
    const r = await client.listAttachments("DEV-42");
    expect(calledUrl).toMatch(/\/rest\/api\/3\/issue\/DEV-42/);
    expect(calledUrl).toMatch(/fields=attachment/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(1);
      expect(r.data.results[0]?.id).toBe("10001");
      expect(r.data.results[0]?.filename).toBe("report.pdf");
      expect(r.data.results[0]?.mediaType).toBe("application/pdf");
    }
  });

  it("getAttachmentDownload fetches raw bytes", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const client = makeClient({}, async () =>
      new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="x.pdf"',
        },
      }),
    );
    const r = await client.getAttachmentDownload("10001");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.from(r.data.bytes)).toEqual([1, 2, 3]);
      expect(r.data.contentType).toBe("application/pdf");
      expect(r.data.filename).toBe("x.pdf");
    }
  });

  it("getComments converts ADF body to plain text", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse({
        comments: [
          {
            id: "c1",
            author: { displayName: "Bob" },
            created: "2026-04-01T00:00:00Z",
            updated: "2026-04-01T00:00:00Z",
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Hello world" }],
                },
              ],
            },
          },
        ],
        total: 1,
      });
    });
    const r = await client.getComments("DEV-42");
    expect(calledUrl).toMatch(/\/rest\/api\/3\/issue\/DEV-42\/comment/);
    expect(calledUrl).toMatch(/orderBy=created/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(1);
      expect(r.data.results[0]?.id).toBe("c1");
      expect(r.data.results[0]?.author).toBe("Bob");
      expect(r.data.results[0]?.body_plain).toBe("Hello world");
    }
  });
});

describe("JiraClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects invalid site URLs at construction", () => {
    expect(
      () =>
        new JiraClient({
          siteUrl: "ftp://evil.example",
          email: "a",
          apiToken: "b",
        }),
    ).toThrow(/Invalid Jira site URL/);
  });

  it("builds URLs with query params and attaches Basic auth", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const client = makeClient({}, async (url, init) => {
      calls.push({ url, headers: new Headers(init?.headers as HeadersInit) });
      return jsonResponse({ total: 0, issues: [] });
    });
    const res = await client.searchJql("project = WIKI", 25, 0);
    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toMatch(
      /https:\/\/example\.atlassian\.net\/rest\/api\/3\/search\/jql\?jql=project/,
    );
    expect(calls[0]?.headers.get("authorization")).toMatch(/^Basic /);
  });

  it("rejects disallowed methods", async () => {
    const client = makeClient();
    const res = await client.request("PATCH" as never, "/rest/api/3/search");
    expect(res).toEqual(
      expect.objectContaining({ ok: false, code: "METHOD_NOT_ALLOWED" }),
    );
  });

  it("retries on 429 and succeeds", async () => {
    let calls = 0;
    const client = makeClient({ rateLimitPerMin: 100 }, async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({}, { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse({ total: 1, issues: [{ key: "A-1" }] });
    });
    const res = await client.searchJql("x", 10);
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
  });

  it("surfaces 404 as NOT_FOUND and is non-retriable", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ error: "missing" }, { status: 404 }),
    );
    const res = await client.getIssue("AAA-1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("NOT_FOUND");
      expect(res.retriable).toBe(false);
    }
  });
});

describe("jira connector — fetch()", () => {
  beforeEach(() => {
    delete process.env["JIRA_SITE_URL"];
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_API_TOKEN"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("exposes validActions", () => {
    const c = buildJiraConnector();
    expect([...c.validActions].sort()).toEqual([
      "add_comment",
      "create_issue",
      "delete_comment",
      "delete_issue",
      "get_attachment",
      "get_comments",
      "get_issue",
      "get_project",
      "jql_search",
      "list_attachments",
      "post_attachment",
      "transition_issue",
      "update_comment",
      "update_issue",
    ]);
  });

  it("list_attachments returns normalized attachments", async () => {
    const client = makeClient({}, async (url) => {
      expect(url).toMatch(/\/rest\/api\/3\/issue\/DEV-42/);
      expect(url).toMatch(/fields=attachment/);
      return jsonResponse({
        key: "DEV-42",
        fields: {
          attachment: [
            {
              id: "10001",
              filename: "doc.pdf",
              mimeType: "application/pdf",
              size: 999,
              created: "2026-04-01T00:00:00Z",
              author: { displayName: "Alice" },
              content:
                "https://example.atlassian.net/rest/api/3/attachment/content/10001",
            },
          ],
        },
      });
    });
    const c = makeConnector(client);
    const r = await c.fetch("list_attachments", { issue_key: "DEV-42" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const atts = r.data["attachments"] as Array<Record<string, unknown>>;
      expect(atts).toHaveLength(1);
      expect(atts[0]?.["attachment_id"]).toBe("10001");
      expect(atts[0]?.["filename"]).toBe("doc.pdf");
    }
  });

  it("get_attachment fetches + extracts text file", async () => {
    const body = new TextEncoder().encode("hello");
    const client = makeClient({}, async (url) => {
      if (url.includes("/attachment/content/10001")) {
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="note.txt"',
          },
        });
      }
      return jsonResponse({
        key: "DEV-42",
        fields: {
          attachment: [
            {
              id: "10001",
              filename: "note.txt",
              mimeType: "text/plain",
              size: body.byteLength,
              content:
                "https://example.atlassian.net/rest/api/3/attachment/content/10001",
            },
          ],
        },
      });
    });
    const c = makeConnector(client);
    const r = await c.fetch("get_attachment", {
      issue_key: "DEV-42",
      attachment_id: "10001",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["attachment_id"]).toBe("10001");
      expect(r.data["filename"]).toBe("note.txt");
      const extracted = r.data["extracted"] as Record<string, unknown>;
      expect(extracted["format"]).toBe("text");
      expect(extracted["text"]).toBe("hello");
    }
  });

  it("get_attachment returns NOT_FOUND for unknown id", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ key: "DEV-42", fields: { attachment: [] } }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_attachment", {
      issue_key: "DEV-42",
      attachment_id: "nope",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });

  it("get_comments returns ADF-converted plain text", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        total: 1,
        comments: [
          {
            id: "c1",
            author: { displayName: "Bob" },
            created: "2026-04-01T00:00:00Z",
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "hello" }],
                },
              ],
            },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_comments", { issue_key: "DEV-42" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const comments = r.data["comments"] as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0]?.["body_plain"]).toBe("hello");
      expect(comments[0]?.["author"]).toBe("Bob");
    }
  });

  it("returns VALIDATION_ERROR for unknown action", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("nope", {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR for missing jql", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("jql_search", {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR for malformed issue_key", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("get_issue", { issue_key: "bad-key" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("returns CONFIG_ERROR when no credentials configured", async () => {
    const c = buildJiraConnector();
    const r = await c.fetch("jql_search", { jql: "project = WIKI" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.retriable).toBe(false);
      expect(r.message).toContain("JIRA_");
    }
  });

  it("invokes injected client and reshapes response", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        total: 2,
        issues: [
          {
            key: "FOO-1",
            fields: {
              summary: "hello",
              status: { name: "Open" },
              assignee: { displayName: "Jane" },
              labels: ["a"],
              updated: "2026-04-01",
            },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("jql_search", {
      jql: "project = FOO",
      max_results: 10,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      // The new /rest/api/3/search/jql endpoint doesn't return a total —
      // we synthesize it from issues.length, so it tracks the array.
      expect(r.data["total"]).toBe(1);
      const first = (r.data["issues"] as Array<Record<string, unknown>>)[0];
      expect(first?.["key"]).toBe("FOO-1");
      expect(first?.["assignee"]).toBe("Jane");
    }
  });

  it("surfaces 401 as AUTH_ERROR", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 401 }));
    const c = makeConnector(client);
    const r = await c.fetch("get_project", { project_key: "FOO" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("AUTH_ERROR");
  });
});

describe("envelope is wiki-agnostic — no mermaid", () => {
  it("jql_search does NOT include a mermaid field", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        total: 1,
        issues: [
          {
            key: "FOO-1",
            fields: { summary: "fix login", status: { name: "Done" } },
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("jql_search", { jql: "project = FOO" });
    expect(r.status).toBe("success");
    if (r.status === "success") expect(r.data["mermaid"]).toBeUndefined();
  });
});

// ─── Write-action tests ───────────────────────────────────────────────────────
//
// HTTP-shape coverage is done directly via JiraClient (no policy gate).
// Connector-level tests use a connector built with write: "success" to reach
// the handler without an escalate envelope.

function makeWriteConnector(
  client: JiraClient,
) {
  return buildJiraConnector({
    sdk: async () => client,
    credentials: async () => ({ email: "user@example.com" }),
    defaultPolicy: { read: "success", write: "success", admin: "denied" },
  });
}

describe("JiraClient — write methods", () => {
  afterEach(() => vi.restoreAllMocks());

  it("createIssue sends POST with JSON body", async () => {
    let method = "";
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      sentBody = init?.body as string;
      return jsonResponse({ key: "PROJ-1", id: "10001", self: "https://x" }, { status: 201 });
    });
    const r = await client.createIssue({ fields: { summary: "hello" } });
    expect(r.ok).toBe(true);
    expect(method).toBe("POST");
    expect(JSON.parse(sentBody)).toMatchObject({ fields: { summary: "hello" } });
  });

  it("updateIssue sends PUT and handles 204", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    const r = await client.updateIssue("PROJ-1", { fields: { summary: "new" } });
    expect(r.ok).toBe(true);
    expect(method).toBe("PUT");
  });

  it("deleteIssue sends DELETE and handles 204", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteIssue("PROJ-1");
    expect(r.ok).toBe(true);
    expect(method).toBe("DELETE");
  });

  it("addComment sends POST with body", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return jsonResponse(
        { id: "c1", author: { displayName: "Alice" }, created: "2026-01-01", updated: "2026-01-01" },
        { status: 201 },
      );
    });
    const r = await client.addComment("PROJ-1", { body: { type: "doc", version: 1, content: [] } });
    expect(r.ok).toBe(true);
    expect(method).toBe("POST");
  });

  it("updateComment sends PUT", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return jsonResponse(
        { id: "c1", author: { displayName: "Alice" }, updated: "2026-01-02" },
        { status: 200 },
      );
    });
    const r = await client.updateComment("PROJ-1", "c1", { body: {} });
    expect(r.ok).toBe(true);
    expect(method).toBe("PUT");
  });

  it("deleteComment sends DELETE and handles 204", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteComment("PROJ-1", "c1");
    expect(r.ok).toBe(true);
    expect(method).toBe("DELETE");
  });

  it("transitionIssue sends POST and handles 204", async () => {
    let method = "";
    const client = makeClient({}, async (_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    const r = await client.transitionIssue("PROJ-1", { transition: { id: "21" } });
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
        [{ id: "att1", filename: "hello.txt", mimeType: "text/plain", size: 5 }],
        { status: 200 },
      );
    });
    const r = await client.postAttachment("PROJ-1", [
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

describe("jira connector — write actions (write: success policy)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("create_issue returns {key, id, self}", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ key: "PROJ-1", id: "10001", self: "https://x/10001" }, { status: 201 }),
    );
    const c = makeWriteConnector(client);
    const r = await c.fetch("create_issue", {
      project_key: "PROJ",
      issue_type: "Task",
      summary: "Do something",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["key"]).toBe("PROJ-1");
      expect(r.data["id"]).toBe("10001");
    }
  });

  it("create_issue with plain description converts to ADF", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return jsonResponse({ key: "PROJ-2", id: "10002", self: "https://x" }, { status: 201 });
    });
    const c = makeWriteConnector(client);
    await c.fetch("create_issue", {
      project_key: "PROJ",
      issue_type: "Bug",
      summary: "crash on login",
      description: { format: "plain", value: "It crashes." },
    });
    const body = JSON.parse(sentBody);
    expect(body.fields.description).toMatchObject({ type: "doc", version: 1 });
  });

  it("update_issue returns {key, updated: true}", async () => {
    const client = makeClient({}, async () => new Response(null, { status: 204 }));
    const c = makeWriteConnector(client);
    const r = await c.fetch("update_issue", {
      issue_key: "PROJ-1",
      summary: "updated title",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["key"]).toBe("PROJ-1");
      expect(r.data["updated"]).toBe(true);
    }
  });

  it("delete_issue returns {key, deleted: true}", async () => {
    const client = makeClient({}, async () => new Response(null, { status: 204 }));
    const c = makeWriteConnector(client);
    const r = await c.fetch("delete_issue", { issue_key: "PROJ-1" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["key"]).toBe("PROJ-1");
      expect(r.data["deleted"]).toBe(true);
    }
  });

  it("add_comment returns {comment_id, created, author}", async () => {
    const client = makeClient({}, async () =>
      jsonResponse(
        { id: "c42", author: { displayName: "Bob" }, created: "2026-01-01", updated: "2026-01-01" },
        { status: 201 },
      ),
    );
    const c = makeWriteConnector(client);
    const r = await c.fetch("add_comment", {
      issue_key: "PROJ-1",
      body: { format: "plain", value: "Looks good." },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["comment_id"]).toBe("c42");
      expect(r.data["author"]).toBe("Bob");
    }
  });

  it("update_comment returns {comment_id, updated, author}", async () => {
    const client = makeClient({}, async () =>
      jsonResponse(
        { id: "c42", author: { displayName: "Alice" }, updated: "2026-02-01" },
        { status: 200 },
      ),
    );
    const c = makeWriteConnector(client);
    const r = await c.fetch("update_comment", {
      issue_key: "PROJ-1",
      comment_id: "c42",
      body: { format: "plain", value: "Updated." },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["comment_id"]).toBe("c42");
      expect(r.data["updated"]).toBe("2026-02-01");
    }
  });

  it("delete_comment returns {comment_id, deleted: true}", async () => {
    const client = makeClient({}, async () => new Response(null, { status: 204 }));
    const c = makeWriteConnector(client);
    const r = await c.fetch("delete_comment", {
      issue_key: "PROJ-1",
      comment_id: "c42",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["comment_id"]).toBe("c42");
      expect(r.data["deleted"]).toBe(true);
    }
  });

  it("transition_issue returns {issue_key, transitioned: true}", async () => {
    const client = makeClient({}, async () => new Response(null, { status: 204 }));
    const c = makeWriteConnector(client);
    const r = await c.fetch("transition_issue", {
      issue_key: "PROJ-1",
      transition_id: "21",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["issue_key"]).toBe("PROJ-1");
      expect(r.data["transitioned"]).toBe(true);
    }
  });

  it("post_attachment (base64) returns {issue_key, attachments}", async () => {
    const client = makeClient({}, async () =>
      jsonResponse(
        [{ id: "att1", filename: "doc.txt", mimeType: "text/plain", size: 3 }],
        { status: 200 },
      ),
    );
    const c = makeWriteConnector(client);
    const r = await c.fetch("post_attachment", {
      issue_key: "PROJ-1",
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
      expect(r.data["issue_key"]).toBe("PROJ-1");
      const atts = r.data["attachments"] as Array<Record<string, unknown>>;
      expect(atts).toHaveLength(1);
      expect(atts[0]?.["attachment_id"]).toBe("att1");
      expect(atts[0]?.["filename"]).toBe("doc.txt");
    }
  });

  it("post_attachment (base64, no mime_type) sends FormData", async () => {
    let capturedBody: unknown = null;
    const client = makeClient({}, async (_url, init) => {
      capturedBody = init?.body;
      return jsonResponse(
        [{ id: "att2", filename: "x.txt", mimeType: "application/octet-stream", size: 0 }],
        { status: 200 },
      );
    });
    const c = makeWriteConnector(client);
    await c.fetch("post_attachment", {
      issue_key: "PROJ-1",
      files: [
        {
          filename: "x.txt",
          content_base64: Buffer.from([0, 1, 2]).toString("base64"),
        },
      ],
    });
    // Body should be FormData
    expect(capturedBody).toBeInstanceOf(FormData);
  });

  it("post_attachment with path outside CWD returns VALIDATION_ERROR (sdk never called)", async () => {
    let sdkCalled = false;
    const client = makeClient({}, async () => {
      sdkCalled = true;
      return jsonResponse([], { status: 200 });
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("post_attachment", {
      issue_key: "PROJ-1",
      files: [{ path: "/etc/passwd" }],
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
    expect(sdkCalled).toBe(false);
  });

  it("post_attachment (path input, explicit mime_type) uploads multipart correctly", async () => {
    // Write fixture inside cwd so checkPathContainment passes.
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-jira-test-"));
    const tmpFile = path.join(tmpDir, "note.txt");
    fs.writeFileSync(tmpFile, "test");
    let capturedHeaders: Headers | null = null;
    let capturedBody: unknown = null;
    try {
      const client = makeClient({}, async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body;
        return jsonResponse(
          [{ id: "att3", filename: "note.txt", mimeType: "text/plain", size: 4 }],
          { status: 200 },
        );
      });
      const c = makeWriteConnector(client);
      const r = await c.fetch("post_attachment", {
        issue_key: "PROJ-1",
        files: [{ path: tmpFile, mime_type: "text/plain" }],
      });
      expect(r.status).toBe("success");
      if (r.status === "success") {
        expect(r.data["issue_key"]).toBe("PROJ-1");
        const atts = r.data["attachments"] as Array<Record<string, unknown>>;
        expect(atts).toHaveLength(1);
        expect(atts[0]?.["attachment_id"]).toBe("att3");
      }
      // Multipart: no explicit Content-Type, X-Atlassian-Token present, body is FormData
      expect(capturedHeaders!.get("X-Atlassian-Token")).toBe("no-check");
      expect(capturedHeaders!.get("Content-Type")).toBeNull();
      expect(capturedBody).toBeInstanceOf(FormData);
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it("post_attachment (path input, .json extension) infers mime type via EXT_MIME", async () => {
    // No mime_type provided — connector should infer application/json from .json extension.
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-jira-test-"));
    const tmpFile = path.join(tmpDir, "data.json");
    fs.writeFileSync(tmpFile, '{"key":1}');
    try {
      const client = makeClient({}, async () =>
        jsonResponse(
          [{ id: "att4", filename: "data.json", mimeType: "application/json", size: 9 }],
          { status: 200 },
        ),
      );
      const c = makeWriteConnector(client);
      const r = await c.fetch("post_attachment", {
        issue_key: "PROJ-1",
        files: [{ path: tmpFile }],
      });
      expect(r.status).toBe("success");
      if (r.status === "success") {
        const atts = r.data["attachments"] as Array<Record<string, unknown>>;
        expect(atts[0]?.["attachment_id"]).toBe("att4");
        expect(atts[0]?.["media_type"]).toBe("application/json");
      }
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it("transition_issue with comment sends ADF in update.comment", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return new Response(null, { status: 204 });
    });
    const c = makeWriteConnector(client);
    const r = await c.fetch("transition_issue", {
      issue_key: "PROJ-1",
      transition_id: "31",
      comment: { format: "markdown", value: "moving to done" },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["issue_key"]).toBe("PROJ-1");
      expect(r.data["transitioned"]).toBe(true);
    }
    const body = JSON.parse(sentBody);
    // Transition ID forwarded correctly
    expect(body.transition).toEqual({ id: "31" });
    // ADF comment embedded in update.comment[0].add.body
    const adfBody = body?.update?.comment?.[0]?.add?.body;
    expect(adfBody).toBeDefined();
    expect(adfBody.type).toBe("doc");
    expect(adfBody.version).toBe(1);
    expect(Array.isArray(adfBody.content)).toBe(true);
    // At least one paragraph node containing the text
    const paragraphs = adfBody.content.filter((n: { type: string }) => n.type === "paragraph");
    expect(paragraphs.length).toBeGreaterThan(0);
    const allText = paragraphs
      .flatMap((p: { content?: Array<{ type: string; text?: string }> }) =>
        (p.content ?? []).filter((n) => n.type === "text").map((n) => n.text ?? ""),
      )
      .join("");
    expect(allText).toContain("moving to done");
  });

  it("transition_issue rejects invalid ADF comment with VALIDATION_ERROR", async () => {
    const client = makeClient({}, async () => new Response(null, { status: 204 }));
    const c = makeWriteConnector(client);
    const r = await c.fetch("transition_issue", {
      issue_key: "PROJ-1",
      transition_id: "31",
      comment: { format: "adf", value: { type: "paragraph" } }, // missing doc root
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("add_comment with markdown format → ADF body sent", async () => {
    let sentBody = "";
    const client = makeClient({}, async (_url, init) => {
      sentBody = init?.body as string;
      return jsonResponse(
        { id: "c1", author: { displayName: "Alice" }, created: "2026-01-01" },
        { status: 201 },
      );
    });
    const c = makeWriteConnector(client);
    await c.fetch("add_comment", {
      issue_key: "PROJ-1",
      body: { format: "markdown", value: "**hello**" },
    });
    const body = JSON.parse(sentBody);
    expect(body.body).toMatchObject({ type: "doc", version: 1 });
  });

  it("create_issue returns VALIDATION_ERROR for invalid ADF", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ key: "X" }, { status: 201 }),
    );
    const c = makeWriteConnector(client);
    const r = await c.fetch("create_issue", {
      project_key: "PROJ",
      issue_type: "Task",
      summary: "test",
      description: { format: "adf", value: { type: "not-doc", version: 1, content: [] } },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });
});
