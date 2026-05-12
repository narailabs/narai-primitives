/**
 * Extras tests for gitlab_client.ts — covers retry/timeout/rate-limit
 * behaviour, loadGitlabCredentials() precedence, projectPath encoding,
 * and the single concrete method getProject().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitlabClient,
  type GitlabClientOptions,
  loadGitlabCredentials,
} from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

// Mock the credentials module so loadGitlabCredentials is fully testable.
vi.mock("narai-primitives/credentials", () => ({
  resolveSecret: vi.fn(async () => null),
}));
import { resolveSecret } from "narai-primitives/credentials";

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
  overrides: Partial<GitlabClientOptions> = {},
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
): GitlabClient {
  return new GitlabClient({
    token: "glpat_test",
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

// ── Retry & timeout behaviour ────────────────────────────────────────────────

describe("GitlabClient — retry & timeout branches", () => {
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
        return jsonResponse({ id: 1, name: "my-project", path_with_namespace: "foo/my-project" });
      },
    );
    const r = await client.getProject("foo", "my-project");
    expect(calls).toBe(2);
    expect(sleeps[0]).toBe(2000);
    expect(r.ok).toBe(true);
  });

  it("retries on 5xx using exponential backoff then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = makeClient(
      { sleepImpl: async (ms) => void sleeps.push(ms) },
      async () => {
        calls++;
        if (calls < 3) return new Response("boom", { status: 503 });
        return jsonResponse({ id: 1, name: "proj", path_with_namespace: "ns/proj" });
      },
    );
    const r = await client.getProject("ns", "proj");
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(500);
    expect(sleeps[1]).toBe(1000);
    expect(r.ok).toBe(true);
  });

  it("returns SERVER_ERROR after all retry attempts are exhausted on 5xx", async () => {
    const client = makeClient({}, async () => new Response("nope", { status: 500 }));
    const r = await client.getProject("ns", "proj");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SERVER_ERROR");
      expect(r.retriable).toBe(true);
      expect(r.status).toBe(500);
    }
  });

  it("returns RATE_LIMITED after all retry attempts exhausted on 429", async () => {
    const client = makeClient({}, async () => new Response("rate", { status: 429 }));
    const r = await client.getProject("ns", "proj");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("RATE_LIMITED");
      expect(r.retriable).toBe(true);
    }
  });

  it("classifies DOMException AbortError as TIMEOUT", async () => {
    let calls = 0;
    const client = makeClient({}, async () => {
      calls++;
      if (calls === 1) throw new DOMException("aborted", "AbortError");
      return jsonResponse({ id: 1, name: "p", path_with_namespace: "ns/p" });
    });
    const r = await client.getProject("ns", "p");
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("returns TIMEOUT after all retry attempts on repeated DOMException", async () => {
    const client = makeClient({}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const r = await client.getProject("ns", "proj");
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
    const r = await client.getProject("ns", "proj");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.message).toContain("ECONNRESET");
    }
  });
});

// ── getProject happy path ────────────────────────────────────────────────────

describe("GitlabClient.getProject — happy path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hits /api/v4/projects/<encoded-path> with GET and Bearer auth", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedHeaders: Headers | undefined;

    const client = makeClient({}, async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedHeaders = new Headers(init?.headers as HeadersInit);
      return jsonResponse({ id: 42, name: "my-project", path_with_namespace: "foo/my-project" });
    });

    const r = await client.getProject("foo", "my-project");
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("GET");
    expect(usedUrl).toMatch(/\/api\/v4\/projects\/foo%2Fmy-project$/);
    expect(usedHeaders?.get("authorization")).toBe("Bearer glpat_test");
  });

  it("uses the custom host in baseUrl when provided", async () => {
    let usedUrl = "";
    const client = new GitlabClient({
      token: "tok",
      host: "https://gitlab.example.com",
      fetchImpl: async (url) => {
        usedUrl = String(url);
        return jsonResponse({ id: 1, name: "p", path_with_namespace: "ns/p" });
      },
      sleepImpl: async () => {},
    });
    await client.getProject("ns", "p");
    expect(usedUrl).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\//);
  });

  it("getProject returns the parsed project data", async () => {
    const project = { id: 7, name: "my-project", path_with_namespace: "mygroup/my-project", default_branch: "main" };
    const client = makeClient({}, async () => jsonResponse(project));
    const r = await client.getProject("mygroup", "my-project");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.id).toBe(7);
      expect(r.data.path_with_namespace).toBe("mygroup/my-project");
    }
  });
});

// ── projectPath encoding ─────────────────────────────────────────────────────

describe("GitlabClient.projectPath — URL encoding", () => {
  it("encodes simple namespace/project with %2F", () => {
    const client = makeClient();
    expect(client.projectPath("foo", "bar")).toBe("foo%2Fbar");
  });

  it("encodes slashes in group/subgroup/project path", () => {
    const client = makeClient();
    expect(client.projectPath("group/sub", "myproject")).toBe("group%2Fsub%2Fmyproject");
  });
});

// ── host / defaultNamespace getters ─────────────────────────────────────────

describe("GitlabClient getters", () => {
  it("host returns the host part of the gitlab URL", () => {
    const client = new GitlabClient({ token: "t", sleepImpl: async () => {} });
    expect(client.host).toBe("gitlab.com");
  });

  it("host reflects custom host option", () => {
    const client = new GitlabClient({
      token: "t",
      host: "https://gitlab.internal",
      sleepImpl: async () => {},
    });
    expect(client.host).toBe("gitlab.internal");
  });

  it("defaultNamespace is null when not provided", () => {
    const client = makeClient();
    expect(client.defaultNamespace).toBeNull();
  });

  it("defaultNamespace reflects constructor option", () => {
    const client = new GitlabClient({
      token: "t",
      defaultNamespace: "mygroup",
      sleepImpl: async () => {},
    });
    expect(client.defaultNamespace).toBe("mygroup");
  });
});

// ── loadGitlabCredentials() ──────────────────────────────────────────────────

describe("loadGitlabCredentials()", () => {
  beforeEach(() => {
    vi.mocked(resolveSecret).mockReset();
    delete process.env["GITLAB_TOKEN"];
    delete process.env["GITLAB_HOST"];
    delete process.env["GITLAB_NAMESPACE"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns null when no token is found anywhere", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    const r = await loadGitlabCredentials();
    expect(r).toBeNull();
  });

  it("uses GITLAB_TOKEN env var when resolveSecret returns null", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["GITLAB_TOKEN"] = "env-token";
    const r = await loadGitlabCredentials();
    expect(r).not.toBeNull();
    expect(r?.token).toBe("env-token");
    expect(r?.host).toBeNull();
    expect(r?.defaultNamespace).toBeNull();
  });

  it("uses GITLAB_HOST env var to override the default host", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["GITLAB_TOKEN"] = "env-token";
    process.env["GITLAB_HOST"] = "https://gitlab.mycorp";
    const r = await loadGitlabCredentials();
    expect(r?.host).toBe("https://gitlab.mycorp");
  });

  it("uses GITLAB_NAMESPACE env var to set defaultNamespace", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["GITLAB_TOKEN"] = "env-token";
    process.env["GITLAB_NAMESPACE"] = "mygroup";
    const r = await loadGitlabCredentials();
    expect(r?.defaultNamespace).toBe("mygroup");
  });

  it("prefers resolveSecret value over env var for token", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) => {
      if (key === "GITLAB_TOKEN") return "secret-token";
      return null;
    });
    process.env["GITLAB_TOKEN"] = "env-token";
    const r = await loadGitlabCredentials();
    expect(r?.token).toBe("secret-token");
  });

  it("prefers resolveSecret value over env var for host and namespace", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) => {
      if (key === "GITLAB_TOKEN") return "sec-token";
      if (key === "GITLAB_HOST") return "https://secret-host";
      if (key === "GITLAB_NAMESPACE") return "secret-ns";
      return null;
    });
    process.env["GITLAB_TOKEN"] = "env-token";
    process.env["GITLAB_HOST"] = "https://env-host";
    process.env["GITLAB_NAMESPACE"] = "env-ns";
    const r = await loadGitlabCredentials();
    expect(r).toEqual({
      token: "sec-token",
      host: "https://secret-host",
      defaultNamespace: "secret-ns",
    });
  });

  it("returns null defaultNamespace when neither secret nor env is set for namespace", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) =>
      key === "GITLAB_TOKEN" ? "tok" : null,
    );
    const r = await loadGitlabCredentials();
    expect(r?.defaultNamespace).toBeNull();
  });

  it("returns null host when neither secret nor env sets GITLAB_HOST", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) =>
      key === "GITLAB_TOKEN" ? "tok" : null,
    );
    const r = await loadGitlabCredentials();
    expect(r?.host).toBeNull();
  });

  it("returns env host when secret returns null for GITLAB_HOST", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) =>
      key === "GITLAB_TOKEN" ? "tok" : null,
    );
    process.env["GITLAB_HOST"] = "https://env-only.example";
    const r = await loadGitlabCredentials();
    expect(r?.host).toBe("https://env-only.example");
  });
});
