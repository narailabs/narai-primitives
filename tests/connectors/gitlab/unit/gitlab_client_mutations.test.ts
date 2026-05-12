/**
 * Tests for GitlabClient mutation methods added in Task 4:
 * createMergeRequest, updateMergeRequest, closeMergeRequest, mergeMergeRequest.
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

const mrBody = {
  iid: 5,
  title: "Test MR",
  state: "opened",
  draft: false,
  source_branch: "feat",
  target_branch: "main",
  sha: "abc123",
  description: null,
  web_url: "https://gitlab.com/g/p/-/merge_requests/5",
  updated_at: "2024-01-01T00:00:00Z",
};

// ── createMergeRequest ────────────────────────────────────────────────────────

describe("GitlabClient.createMergeRequest", () => {
  it("calls POST /projects/<encoded>/merge_requests with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse(mrBody, 201);
    });
    const r = await client.createMergeRequest("mygroup", "myproject", {
      source_branch: "feat",
      target_branch: "main",
      title: "Test MR",
      draft: false,
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests$/);
    expect((usedBody as Record<string, unknown>)["title"]).toBe("Test MR");
    expect((usedBody as Record<string, unknown>)["source_branch"]).toBe("feat");
  });
});

// ── updateMergeRequest ────────────────────────────────────────────────────────

describe("GitlabClient.updateMergeRequest", () => {
  it("calls PUT /projects/<encoded>/merge_requests/:iid with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...mrBody, title: "Updated" });
    });
    const r = await client.updateMergeRequest("mygroup", "myproject", 5, {
      title: "Updated",
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5$/);
    expect((usedBody as Record<string, unknown>)["title"]).toBe("Updated");
  });
});

// ── closeMergeRequest ─────────────────────────────────────────────────────────

describe("GitlabClient.closeMergeRequest", () => {
  it("calls PUT /projects/<encoded>/merge_requests/:iid with state_event=close", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...mrBody, state: "closed" });
    });
    const r = await client.closeMergeRequest("mygroup", "myproject", 5);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5$/);
    expect((usedBody as Record<string, unknown>)["state_event"]).toBe("close");
  });
});

// ── mergeMergeRequest ─────────────────────────────────────────────────────────

describe("GitlabClient.mergeMergeRequest", () => {
  it("calls PUT /projects/<encoded>/merge_requests/:iid/merge with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ sha: "deadbeef", merged: true, message: "Merged" });
    });
    const r = await client.mergeMergeRequest("mygroup", "myproject", 5, {
      merge_commit_message: "chore: merge feat",
      should_remove_source_branch: true,
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5\/merge$/);
    expect((usedBody as Record<string, unknown>)["merge_commit_message"]).toBe("chore: merge feat");
    expect((usedBody as Record<string, unknown>)["should_remove_source_branch"]).toBe(true);
  });
});
