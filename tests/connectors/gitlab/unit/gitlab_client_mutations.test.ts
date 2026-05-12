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

// ── createIssue ───────────────────────────────────────────────────────────────

const issueBody = {
  iid: 3,
  title: "Test issue",
  state: "opened",
  author: { username: "bob" },
  labels: ["bug"],
  description: null,
  web_url: "https://gitlab.com/g/p/-/issues/3",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("GitlabClient.createIssue", () => {
  it("calls POST /projects/<encoded>/issues with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse(issueBody, 201);
    });
    const r = await client.createIssue("mygroup", "myproject", {
      title: "Test issue",
      labels: "bug",
      assignee_ids: [1],
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/issues$/);
    expect((usedBody as Record<string, unknown>)["title"]).toBe("Test issue");
    expect((usedBody as Record<string, unknown>)["labels"]).toBe("bug");
    expect((usedBody as Record<string, unknown>)["assignee_ids"]).toEqual([1]);
  });
});

// ── updateIssue ───────────────────────────────────────────────────────────────

describe("GitlabClient.updateIssue", () => {
  it("calls PUT /projects/<encoded>/issues/:iid with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...issueBody, title: "Updated" });
    });
    const r = await client.updateIssue("mygroup", "myproject", 3, {
      title: "Updated",
      state_event: "reopen",
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/issues\/3$/);
    expect((usedBody as Record<string, unknown>)["title"]).toBe("Updated");
    expect((usedBody as Record<string, unknown>)["state_event"]).toBe("reopen");
  });
});

// ── closeIssue ────────────────────────────────────────────────────────────────

describe("GitlabClient.closeIssue", () => {
  it("calls PUT /projects/<encoded>/issues/:iid with state_event=close", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...issueBody, state: "closed" });
    });
    const r = await client.closeIssue("mygroup", "myproject", 3);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/issues\/3$/);
    expect((usedBody as Record<string, unknown>)["state_event"]).toBe("close");
  });
});

// ── addNote ───────────────────────────────────────────────────────────────────

const noteBody = {
  id: 42,
  body: "Hello",
  author: { username: "alice" },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  system: false,
};

describe("GitlabClient.addNote", () => {
  it("calls POST /projects/<encoded>/issues/:iid/notes for issue", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse(noteBody, 201);
    });
    const r = await client.addNote("mygroup", "myproject", "issue", 3, { body: "Hello" });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/issues\/3\/notes$/);
    expect((usedBody as Record<string, unknown>)["body"]).toBe("Hello");
  });

  it("calls POST /projects/<encoded>/merge_requests/:iid/notes for merge_request (no position)", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse(noteBody, 201);
    });
    await client.addNote("mygroup", "myproject", "merge_request", 5, { body: "Hello" });
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5\/notes$/);
  });

  it("POSTs to /discussions when MR note has position payload", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const discussionResp = {
      id: "abc123",
      individual_note: false,
      notes: [noteBody],
    };
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return jsonResponse(discussionResp, 201);
    });
    const r = await client.addNote("mygroup", "myproject", "merge_request", 5, {
      body: "diff comment",
      position: {
        base_sha: "aabb",
        start_sha: "aabb",
        head_sha: "ccdd",
        position_type: "text",
        new_path: "src/foo.ts",
        new_line: 10,
      },
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5\/discussions$/);
    if (r.ok) {
      expect(r.data.id).toBe(noteBody.id);
      expect(r.data.body).toBe(noteBody.body);
    }
  });

  it("returns SERVER_ERROR when discussion endpoint returns empty notes array", async () => {
    const emptyDiscussion = { id: "abc123", individual_note: false, notes: [] };
    const client = makeClient(async () => jsonResponse(emptyDiscussion, 201));
    const r = await client.addNote("mygroup", "myproject", "merge_request", 5, {
      body: "diff comment",
      position: {
        base_sha: "aabb",
        start_sha: "aabb",
        head_sha: "ccdd",
        position_type: "text",
        new_path: "src/foo.ts",
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SERVER_ERROR");
    }
  });
});

// ── updateNote ────────────────────────────────────────────────────────────────

describe("GitlabClient.updateNote", () => {
  it("calls PUT /projects/<encoded>/issues/:iid/notes/:note_id for issue", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...noteBody, body: "Updated" });
    });
    const r = await client.updateNote("mygroup", "myproject", "issue", 3, 42, { body: "Updated" });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/issues\/3\/notes\/42$/);
    expect((usedBody as Record<string, unknown>)["body"]).toBe("Updated");
  });

  it("calls PUT .../merge_requests/:iid/notes/:note_id for merge_request", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ ...noteBody, body: "Updated" });
    });
    await client.updateNote("mygroup", "myproject", "merge_request", 5, 7, { body: "Updated" });
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5\/notes\/7$/);
  });
});

// ── deleteNote ────────────────────────────────────────────────────────────────

describe("GitlabClient.deleteNote", () => {
  it("calls DELETE /projects/<encoded>/issues/:iid/notes/:note_id for issue", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteNote("mygroup", "myproject", "issue", 3, 42);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("DELETE");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/issues\/3\/notes\/42$/);
  });

  it("calls DELETE .../merge_requests/:iid/notes/:note_id for merge_request", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return new Response(null, { status: 204 });
    });
    await client.deleteNote("mygroup", "myproject", "merge_request", 5, 7);
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/merge_requests\/5\/notes\/7$/);
  });
});

// ── createRelease ─────────────────────────────────────────────────────────────

const releaseBody = {
  tag_name: "v1.0.0",
  name: "Version 1.0.0",
  description: "First release",
  created_at: "2024-01-01T00:00:00Z",
};

describe("GitlabClient.createRelease", () => {
  it("calls POST /projects/<encoded>/releases with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse(releaseBody, 201);
    });
    const r = await client.createRelease("mygroup", "myproject", {
      tag_name: "v1.0.0",
      name: "Version 1.0.0",
      description: "First release",
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/releases$/);
    expect((usedBody as Record<string, unknown>)["tag_name"]).toBe("v1.0.0");
    expect((usedBody as Record<string, unknown>)["name"]).toBe("Version 1.0.0");
  });
});

// ── updateRelease ─────────────────────────────────────────────────────────────

describe("GitlabClient.updateRelease", () => {
  it("calls PUT /projects/<encoded>/releases/:tag with body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...releaseBody, name: "Updated" });
    });
    const r = await client.updateRelease("mygroup", "myproject", "v1.0.0", {
      name: "Updated",
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("PUT");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/releases\/v1\.0\.0$/);
    expect((usedBody as Record<string, unknown>)["name"]).toBe("Updated");
  });

  it("percent-encodes tag with slashes", async () => {
    let usedUrl = "";
    const client = makeClient(async (url) => {
      usedUrl = url;
      return jsonResponse({ ...releaseBody, tag_name: "release/1.0" });
    });
    await client.updateRelease("g", "p", "release/1.0", { name: "X" });
    expect(usedUrl).toMatch(/releases\/release%2F1\.0$/);
  });
});

// ── deleteRelease ─────────────────────────────────────────────────────────────

describe("GitlabClient.deleteRelease", () => {
  it("calls DELETE /projects/<encoded>/releases/:tag", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteRelease("mygroup", "myproject", "v1.0.0");
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("DELETE");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/releases\/v1\.0\.0$/);
  });
});

// ── deleteReleaseLink ─────────────────────────────────────────────────────────

describe("GitlabClient.deleteReleaseLink", () => {
  it("calls DELETE /projects/<encoded>/releases/:tag/assets/links/:id", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteReleaseLink("mygroup", "myproject", "v1.0.0", 42);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("DELETE");
    expect(usedUrl).toMatch(
      /\/projects\/mygroup%2Fmyproject\/releases\/v1\.0\.0\/assets\/links\/42$/,
    );
  });
});

// ── retryPipeline ─────────────────────────────────────────────────────────────

const pipelineBody = {
  id: 101,
  status: "running",
  ref: "main",
  sha: "abc123",
  web_url: "https://gitlab.com/g/p/-/pipelines/101",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("GitlabClient.retryPipeline", () => {
  it("calls POST /projects/<encoded>/pipelines/:id/retry", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return jsonResponse(pipelineBody);
    });
    const r = await client.retryPipeline("mygroup", "myproject", 101);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/pipelines\/101\/retry$/);
  });
});

// ── cancelPipeline ────────────────────────────────────────────────────────────

describe("GitlabClient.cancelPipeline", () => {
  it("calls POST /projects/<encoded>/pipelines/:id/cancel", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return jsonResponse({ ...pipelineBody, status: "canceled" });
    });
    const r = await client.cancelPipeline("mygroup", "myproject", 101);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/pipelines\/101\/cancel$/);
  });
});

// ── triggerPipeline ───────────────────────────────────────────────────────────

describe("GitlabClient.triggerPipeline", () => {
  it("calls POST /projects/<encoded>/trigger/pipeline with token and ref in body", async () => {
    let usedUrl = "";
    let usedMethod = "";
    let usedBody: unknown;
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...pipelineBody, id: 202 }, 201);
    });
    const r = await client.triggerPipeline("mygroup", "myproject", {
      token: "glptt_trigger_token",
      ref: "main",
    });
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/trigger\/pipeline$/);
    expect((usedBody as Record<string, unknown>)["token"]).toBe("glptt_trigger_token");
    expect((usedBody as Record<string, unknown>)["ref"]).toBe("main");
  });

  it("includes variables in body when provided", async () => {
    let usedBody: unknown;
    const client = makeClient(async (_url, init) => {
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...pipelineBody, id: 203 }, 201);
    });
    await client.triggerPipeline("g", "p", {
      token: "tok",
      ref: "main",
      variables: { FOO: "bar", BAZ: "qux" },
    });
    expect((usedBody as Record<string, unknown>)["variables"]).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

// ── playJob ───────────────────────────────────────────────────────────────────

const jobBody = {
  id: 55,
  name: "deploy",
  stage: "deploy",
  status: "running",
  web_url: "https://gitlab.com/g/p/-/jobs/55",
  created_at: "2024-01-01T00:00:00Z",
  started_at: null,
  finished_at: null,
  duration: null,
};

describe("GitlabClient.playJob", () => {
  it("calls POST /projects/<encoded>/jobs/:id/play", async () => {
    let usedUrl = "";
    let usedMethod = "";
    const client = makeClient(async (url, init) => {
      usedUrl = url;
      usedMethod = String(init?.method);
      return jsonResponse(jobBody);
    });
    const r = await client.playJob("mygroup", "myproject", 55);
    expect(r.ok).toBe(true);
    expect(usedMethod).toBe("POST");
    expect(usedUrl).toMatch(/\/projects\/mygroup%2Fmyproject\/jobs\/55\/play$/);
  });

  it("includes job_variables_attributes when variables provided", async () => {
    let usedBody: unknown;
    const client = makeClient(async (_url, init) => {
      usedBody = JSON.parse(String(init?.body));
      return jsonResponse(jobBody);
    });
    await client.playJob("mygroup", "myproject", 55, { DEPLOY_ENV: "staging" });
    const attrs = (usedBody as Record<string, unknown>)["job_variables_attributes"] as Array<Record<string, string>>;
    expect(attrs).toEqual([{ key: "DEPLOY_ENV", value: "staging" }]);
  });
});
