/**
 * Tests for the Jira connector built on `@narai/connector-toolkit`.
 */
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

  it("rejects non-GET methods", async () => {
    const client = makeClient();
    const res = await client.request("POST" as never, "/rest/api/3/search");
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
      "get_attachment",
      "get_comments",
      "get_issue",
      "get_project",
      "jql_search",
      "list_attachments",
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
