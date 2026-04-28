/**
 * Tests for the GitHub connector built on `@narai/connector-toolkit`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGithubConnector, githubScope } from "../../../../src/connectors/github/index.js";
import {
  GithubClient,
  type GithubClientOptions,
} from "../../../../src/connectors/github/lib/github_client.js";

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

function makeConnector(client: GithubClient) {
  return buildGithubConnector({
    sdk: async () => client,
    credentials: async () => ({ token: "ghp_test" }),
  });
}

describe("GithubClient — comments + releases", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getIssueComments normalizes comment list", async () => {
    let calledUrl = "";
    const client = makeClient({}, async (url) => {
      calledUrl = url;
      return jsonResponse([
        {
          id: 1,
          user: { login: "alice" },
          created_at: "2026-04-01T00:00:00Z",
          body: "hello",
          html_url: "https://github.com/a/b/issues/1#issuecomment-1",
        },
      ]);
    });
    const r = await client.getIssueComments("a", "b", 1);
    expect(calledUrl).toMatch(/\/repos\/a\/b\/issues\/1\/comments/);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results).toHaveLength(1);
      expect(r.data.results[0]?.author).toBe("alice");
      expect(r.data.results[0]?.body_markdown).toBe("hello");
    }
  });

  it("getPullReviews returns reviews", async () => {
    const client = makeClient({}, async () =>
      jsonResponse([
        {
          id: 10,
          user: { login: "bob" },
          state: "APPROVED",
          submitted_at: "2026-04-02T00:00:00Z",
          body: "lgtm",
        },
      ]),
    );
    const r = await client.getPullReviews("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toHaveLength(1);
      expect(r.data[0]?.state).toBe("APPROVED");
    }
  });

  it("getPullReviewComments returns inline comments", async () => {
    const client = makeClient({}, async () =>
      jsonResponse([
        {
          id: 100,
          user: { login: "carol" },
          path: "src/a.ts",
          line: 42,
          commit_id: "abc123",
          body: "nit: rename",
          diff_hunk: "@@ ...",
        },
      ]),
    );
    const r = await client.getPullReviewComments("a", "b", 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toHaveLength(1);
      expect(r.data[0]?.path).toBe("src/a.ts");
      expect(r.data[0]?.line).toBe(42);
    }
  });

  it("listReleaseByTag returns release + assets", async () => {
    const client = makeClient({}, async (url) => {
      expect(url).toMatch(/\/repos\/a\/b\/releases\/tags\/v1\.0\.0/);
      return jsonResponse({
        id: 777,
        tag_name: "v1.0.0",
        name: "v1.0.0",
        body: "release notes",
        assets: [
          {
            id: 9001,
            name: "binary.tar.gz",
            content_type: "application/gzip",
            size: 42,
            download_count: 3,
            created_at: "2026-04-01",
            updated_at: "2026-04-01",
            browser_download_url: "https://github.com/a/b/releases/download/v1.0.0/binary.tar.gz",
          },
        ],
      });
    });
    const r = await client.listReleaseByTag("a", "b", "v1.0.0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.assets).toHaveLength(1);
      expect(r.data.assets[0]?.id).toBe(9001);
    }
  });

  it("getReleaseAssetDownload returns raw bytes + filename", async () => {
    const body = new Uint8Array([9, 8, 7]);
    const client = makeClient({}, async (url) => {
      expect(url).toMatch(/\/releases\/assets\/9001$/);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/gzip",
          "content-disposition": 'attachment; filename="binary.tar.gz"',
        },
      });
    });
    const r = await client.getReleaseAssetDownload("a", "b", 9001);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.from(r.data.bytes)).toEqual([9, 8, 7]);
      expect(r.data.filename).toBe("binary.tar.gz");
    }
  });
});

describe("GithubClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attaches Bearer + API-version headers", async () => {
    let headers: Headers | undefined;
    const client = makeClient({}, async (_url, init) => {
      headers = new Headers(init?.headers as HeadersInit);
      return jsonResponse({ full_name: "a/b" });
    });
    await client.getRepo("a", "b");
    expect(headers?.get("authorization")).toBe("Bearer ghp_test");
    expect(headers?.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("composes search_code query with repo qualifier", async () => {
    let called = "";
    const client = makeClient({}, async (url) => {
      called = url;
      return jsonResponse({ total_count: 0, items: [] });
    });
    await client.searchCode("foo", "bar", "class Auth");
    expect(called).toMatch(/q=class\+Auth\+repo%3Afoo%2Fbar/);
  });

  it("retries on primary rate limit then succeeds", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          {},
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "retry-after": "0" },
          },
        );
      }
      return jsonResponse({ full_name: "a/b" });
    });
    const r = await client.getRepo("a", "b");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("surfaces 404 as NOT_FOUND non-retriable", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ message: "missing" }, { status: 404 }),
    );
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NOT_FOUND");
      expect(r.retriable).toBe(false);
    }
  });
});

describe("scope(ctx)", () => {
  it("client exposes defaultOwner and host when defaultOwner is set", () => {
    const client = new GithubClient({ token: "x", defaultOwner: "narailabs" });
    expect(client.defaultOwner).toBe("narailabs");
    expect(client.host).toBe("api.github.com");
  });

  it("client exposes null defaultOwner and default host when not set", () => {
    const client = new GithubClient({ token: "x" });
    expect(client.defaultOwner).toBeNull();
    expect(client.host).toBe("api.github.com");
  });

  it("githubScope returns `${host}/${defaultOwner}` when defaultOwner is set", () => {
    const client = new GithubClient({ token: "x", defaultOwner: "narailabs" });
    expect(
      githubScope({ sdk: client, action: "repo_info", params: {} }),
    ).toBe("api.github.com/narailabs");
  });

  it("githubScope returns null when defaultOwner is missing", () => {
    const client = new GithubClient({ token: "x" });
    expect(
      githubScope({ sdk: client, action: "repo_info", params: {} }),
    ).toBeNull();
  });

  it("buildGithubConnector wires the scope callback through (sanity)", () => {
    const client = new GithubClient({ token: "x", defaultOwner: "narailabs" });
    const c = buildGithubConnector({
      sdk: async () => client,
      credentials: async () => ({ token: "x" }),
    });
    // The connector exposes name + validActions; scope is consumed internally
    // by the toolkit. We verify the callback indirectly via the exported
    // `githubScope` (same function installed into the config).
    expect(c.name).toBe("github");
  });
});

describe("github connector — fetch()", () => {
  beforeEach(() => {
    delete process.env["GITHUB_TOKEN"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("exposes validActions", () => {
    const c = buildGithubConnector();
    expect([...c.validActions].sort()).toEqual([
      "get_file",
      "get_issue_comments",
      "get_issues",
      "get_pr_review_comments",
      "get_pulls",
      "get_release_asset",
      "list_release_assets",
      "repo_info",
      "search_code",
    ]);
  });

  it("get_issue_comments returns shaped envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse([
        {
          id: 1,
          user: { login: "alice" },
          created_at: "2026-04-01T00:00:00Z",
          body: "hello",
          html_url: "https://github.com/a/b/issues/1#issuecomment-1",
        },
      ]),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_issue_comments", {
      owner: "a",
      repo: "b",
      issue_number: 1,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const comments = r.data["comments"] as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0]?.["author"]).toBe("alice");
    }
  });

  it("get_pr_review_comments returns reviews + inline_comments", async () => {
    const client = makeClient({}, async (url) => {
      if (url.includes("/reviews")) {
        return jsonResponse([
          {
            id: 10,
            user: { login: "bob" },
            state: "APPROVED",
            body: "lgtm",
          },
        ]);
      }
      return jsonResponse([
        {
          id: 100,
          user: { login: "carol" },
          path: "src/a.ts",
          line: 42,
          body: "nit",
        },
      ]);
    });
    const c = makeConnector(client);
    const r = await c.fetch("get_pr_review_comments", {
      owner: "a",
      repo: "b",
      pr_number: 5,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const reviews = r.data["reviews"] as Array<Record<string, unknown>>;
      const inline = r.data["inline_comments"] as Array<
        Record<string, unknown>
      >;
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.["state"]).toBe("APPROVED");
      expect(inline).toHaveLength(1);
      expect(inline[0]?.["path"]).toBe("src/a.ts");
    }
  });

  it("list_release_assets returns release + assets", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        id: 777,
        tag_name: "v1.0.0",
        name: "v1.0.0",
        body: "notes",
        assets: [
          {
            id: 9001,
            name: "x.tar.gz",
            content_type: "application/gzip",
            size: 42,
            download_count: 3,
            created_at: "2026-04-01",
            updated_at: "2026-04-01",
            browser_download_url: "https://github.com/a/b/.../x.tar.gz",
          },
        ],
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("list_release_assets", {
      owner: "a",
      repo: "b",
      tag: "v1.0.0",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      const release = r.data["release"] as Record<string, unknown>;
      const assets = r.data["assets"] as Array<Record<string, unknown>>;
      expect(release["tag_name"]).toBe("v1.0.0");
      expect(assets).toHaveLength(1);
      expect(assets[0]?.["asset_id"]).toBe(9001);
    }
  });

  it("get_release_asset extracts text asset", async () => {
    const body = new TextEncoder().encode("README");
    const client = makeClient({}, async () =>
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="README.txt"',
        },
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_release_asset", {
      owner: "a",
      repo: "b",
      asset_id: 9001,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["filename"]).toBe("README.txt");
      const extracted = r.data["extracted"] as Record<string, unknown>;
      expect(extracted["format"]).toBe("text");
      expect(extracted["text"]).toBe("README");
    }
  });

  it("rejects invalid owner", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("repo_info", { owner: "bad/owner", repo: "r" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("returns CONFIG_ERROR when GITHUB_TOKEN missing", async () => {
    const c = buildGithubConnector();
    const r = await c.fetch("repo_info", { owner: "acme", repo: "backend" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.retriable).toBe(false);
      expect(r.message).toContain("GITHUB_TOKEN");
    }
  });

  it("decodes base64 file content via injected client", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        path: "README.md",
        size: 5,
        encoding: "base64",
        content: Buffer.from("hello", "utf-8").toString("base64"),
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("get_file", {
      owner: "a",
      repo: "b",
      path: "README.md",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["content"]).toBe("hello");
    }
  });

  it("rejects path traversal", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("get_file", {
      owner: "a",
      repo: "b",
      path: "../etc/passwd",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("surfaces 401 as AUTH_ERROR", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({}, { status: 401 }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("repo_info", { owner: "a", repo: "b" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("AUTH_ERROR");
  });

  describe("pagination", () => {
    function issueRow(n: number): Record<string, unknown> {
      return {
        number: n,
        title: `issue ${n}`,
        state: "open",
        user: { login: "author" },
        labels: [],
        html_url: `https://github.com/a/b/issues/${n}`,
        updated_at: null,
      };
    }

    function pagedFetch(
      totalCount: number,
      perPage = 100,
    ): [(url: string) => Response, { pages: number[] }] {
      const state = { pages: [] as number[] };
      return [
        (url: string) => {
          const u = new URL(url);
          const page = Number(u.searchParams.get("page") ?? "1");
          state.pages.push(page);
          const start = (page - 1) * perPage;
          const end = Math.min(start + perPage, totalCount);
          const rows: unknown[] = [];
          for (let i = start + 1; i <= end; i++) rows.push(issueRow(i));
          return jsonResponse(rows);
        },
        state,
      ];
    }

    it("iterates through 3 pages when total < max_results", async () => {
      const [fetchImpl, state] = pagedFetch(223);
      const client = makeClient({}, async (url) => fetchImpl(url));
      const c = makeConnector(client);
      const r = await c.fetch("get_issues", {
        owner: "a",
        repo: "b",
        max_results: 500,
      });
      expect(r.status).toBe("success");
      if (r.status === "success") {
        const data = r.data as { total: number; truncated: boolean };
        expect(data.total).toBe(223);
        expect(data.truncated).toBe(false);
      }
      expect(state.pages).toEqual([1, 2, 3]);
    });

    it("stops at max_results and marks truncated", async () => {
      const [fetchImpl, state] = pagedFetch(500);
      const client = makeClient({}, async (url) => fetchImpl(url));
      const c = makeConnector(client);
      const r = await c.fetch("get_pulls", {
        owner: "a",
        repo: "b",
        max_results: 150,
      });
      expect(r.status).toBe("success");
      if (r.status === "success") {
        const data = r.data as { total: number; truncated: boolean };
        expect(data.total).toBe(150);
        expect(data.truncated).toBe(true);
      }
      expect(state.pages).toEqual([1, 2]);
    });
  });
});

describe("envelope is wiki-agnostic — no mermaid", () => {
  it("repo_info does NOT include a mermaid field", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        full_name: "a/b",
        description: "test",
        default_branch: "main",
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("repo_info", { owner: "a", repo: "b" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["mermaid"]).toBeUndefined();
    }
  });
});
