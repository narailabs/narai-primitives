/**
 * Tests for the read methods added to GitlabClient in Task 3.
 * One test per method asserting URL + HTTP method.
 */
import { describe, expect, it } from "vitest";
import {
  GitlabClient,
  type GitlabClientOptions,
} from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function makeClient(
  fetchMock: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<GitlabClientOptions> = {},
): GitlabClient {
  return new GitlabClient({
    token: "glpat_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url, init) => fetchMock(String(url), init),
    sleepImpl: async () => {},
    ...overrides,
  });
}

// ── searchCode ────────────────────────────────────────────────────────────────

describe("GitlabClient.searchCode", () => {
  it("calls GET /projects/<encoded>/search?scope=blobs&search=...", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return jsonResponse([{ filename: "app.ts", path: "src/app.ts", ref: "main", startline: 1, project_id: 1 }]);
    });
    const r = await client.searchCode("mygroup", "my-project", "hello");
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("GET");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmy-project\/search/);
    expect(usedUrl).toContain("scope=blobs");
    expect(usedUrl).toContain("search=hello");
  });

  it("passes page and per_page query params when opts are provided", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([]);
    });
    await client.searchCode("ns", "proj", "myquery", { page: 2, perPage: 50 });
    expect(usedUrl).toContain("page=2");
    expect(usedUrl).toContain("per_page=50");
  });
});

// ── listIssues ────────────────────────────────────────────────────────────────

describe("GitlabClient.listIssues", () => {
  it("calls GET /projects/<encoded>/issues", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([{ iid: 1, title: "Bug", state: "opened" }]);
    });
    const r = await client.listIssues("ns", "proj", { state: "opened", per_page: 10, page: 1 });
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/issues/);
  });
});

// ── getIssue ─────────────────────────────────────────────────────────────────

describe("GitlabClient.getIssue", () => {
  it("calls GET /projects/<encoded>/issues/:iid", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ iid: 5, title: "Feat", state: "opened" });
    });
    const r = await client.getIssue("ns", "proj", 5);
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/issues\/5$/);
  });
});

// ── listMergeRequests ─────────────────────────────────────────────────────────

describe("GitlabClient.listMergeRequests", () => {
  it("calls GET /projects/<encoded>/merge_requests", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([{ iid: 3, title: "feat: x", state: "opened" }]);
    });
    const r = await client.listMergeRequests("ns", "proj", { state: "opened" });
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/merge_requests/);
  });
});

// ── getMergeRequest ───────────────────────────────────────────────────────────

describe("GitlabClient.getMergeRequest", () => {
  it("calls GET /projects/<encoded>/merge_requests/:iid", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ iid: 7, title: "fix", state: "merged" });
    });
    const r = await client.getMergeRequest("ns", "proj", 7);
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/merge_requests\/7$/);
  });
});

// ── getFile ───────────────────────────────────────────────────────────────────

describe("GitlabClient.getFile", () => {
  it("calls GET /projects/<encoded>/repository/files/<encoded-path>?ref=...", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({
        file_name: "README.md",
        file_path: "README.md",
        size: 12,
        encoding: "base64",
        content: Buffer.from("hello").toString("base64"),
        ref: "main",
      });
    });
    const r = await client.getFile("ns", "proj", "README.md", "main");
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/repository\/files\/README\.md/);
    expect(usedUrl).toContain("ref=main");
  });

  it("URL-encodes file path with slashes", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ file_name: "app.ts", file_path: "src/app.ts", size: 5, encoding: "base64", content: "", ref: "main" });
    });
    await client.getFile("ns", "proj", "src/app.ts", "main");
    expect(usedUrl).toContain("src%2Fapp.ts");
  });
});

// ── getNotes ──────────────────────────────────────────────────────────────────

describe("GitlabClient.getNotes", () => {
  it("routes issue noteableType to /issues/:iid/notes", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([]);
    });
    await client.getNotes("ns", "proj", "issue", 1);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/issues\/1\/notes$/);
  });

  it("routes merge_request noteableType to /merge_requests/:iid/notes", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([]);
    });
    await client.getNotes("ns", "proj", "merge_request", 3);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/merge_requests\/3\/notes$/);
  });

  it("passes page and per_page query params when opts are provided", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([]);
    });
    await client.getNotes("ns", "proj", "issue", 1, { page: 3, perPage: 25 });
    expect(usedUrl).toContain("page=3");
    expect(usedUrl).toContain("per_page=25");
  });
});

// ── listReleaseLinks ──────────────────────────────────────────────────────────

describe("GitlabClient.listReleaseLinks", () => {
  it("calls GET /projects/<encoded>/releases/:tag/assets/links", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([{ id: 1, name: "linux", url: "https://x", link_type: "package" }]);
    });
    const r = await client.listReleaseLinks("ns", "proj", "v1.0.0");
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/releases\/v1\.0\.0\/assets\/links$/);
  });
});

// ── getReleaseLink ────────────────────────────────────────────────────────────

describe("GitlabClient.getReleaseLink", () => {
  it("calls GET /projects/<encoded>/releases/:tag/assets/links/:id", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ id: 5, name: "win", url: "https://y", link_type: "package" });
    });
    const r = await client.getReleaseLink("ns", "proj", "v1.0.0", 5);
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/releases\/v1\.0\.0\/assets\/links\/5$/);
  });
});

// ── listPipelines ─────────────────────────────────────────────────────────────

describe("GitlabClient.listPipelines", () => {
  it("calls GET /projects/<encoded>/pipelines", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([{ id: 100, status: "success", ref: "main", sha: "a" }]);
    });
    const r = await client.listPipelines("ns", "proj", { per_page: 20, page: 1 });
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/pipelines/);
  });
});

// ── getPipeline ───────────────────────────────────────────────────────────────

describe("GitlabClient.getPipeline", () => {
  it("calls GET /projects/<encoded>/pipelines/:id", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ id: 200, status: "failed", ref: "feat/x" });
    });
    const r = await client.getPipeline("ns", "proj", 200);
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/pipelines\/200$/);
  });
});

// ── listPipelineJobs ──────────────────────────────────────────────────────────

describe("GitlabClient.listPipelineJobs", () => {
  it("calls GET /projects/<encoded>/pipelines/:id/jobs", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([{ id: 300, name: "test", status: "success" }]);
    });
    const r = await client.listPipelineJobs("ns", "proj", 100);
    expect(r.ok).toBe(true);
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/pipelines\/100\/jobs$/);
  });

  it("passes page and per_page query params when opts are provided", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse([]);
    });
    await client.listPipelineJobs("ns", "proj", 100, { page: 2, perPage: 50 });
    expect(usedUrl).toContain("page=2");
    expect(usedUrl).toContain("per_page=50");
  });
});

// ── getJobLogs ────────────────────────────────────────────────────────────────

describe("GitlabClient.getJobLogs", () => {
  it("calls GET /projects/<encoded>/jobs/:id/trace and returns text", async () => {
    let usedUrl = "";
    const logsText = "Running...\nDone!\n";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return textResponse(logsText);
    });
    const r = await client.getJobLogs("ns", "proj", 300);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe(logsText);
    }
    expect(usedUrl).toMatch(/\/projects\/ns%2Fproj\/jobs\/300\/trace$/);
  });
});
