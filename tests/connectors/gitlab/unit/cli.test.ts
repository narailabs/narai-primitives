/**
 * CLI happy-path tests for the GitLab connector.
 */
import { describe, expect, it } from "vitest";
import { buildGitlabConnector } from "../../../../src/connectors/gitlab/index.js";
import {
  GitlabClient,
  type GitlabClientOptions,
} from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  overrides: Partial<GitlabClientOptions> = {},
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>,
): GitlabClient {
  return new GitlabClient({
    token: "gl_test",
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

function makeConnector(client: GitlabClient) {
  return buildGitlabConnector({
    sdk: async () => client,
    credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
  });
}

describe("gitlab connector — fetch() write domains escalate by default", () => {
  it("create_merge_request escalates with action name in envelope", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("create_merge_request", {
      namespace: "mygroup",
      project: "myrepo",
      source_branch: "feat/x",
      target_branch: "main",
      title: "My MR",
    });
    expect(r.status).toBe("escalate");
    expect((r as { action: string }).action).toBe("create_merge_request");
    expect((r as { reason: string }).reason).toMatch(/write/i);
  });

  it("create_issue escalates with action name in envelope", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("create_issue", {
      namespace: "mygroup",
      project: "myrepo",
      title: "My Issue",
    });
    expect(r.status).toBe("escalate");
    expect((r as { action: string }).action).toBe("create_issue");
  });

  it("add_note escalates with action name in envelope", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("add_note", {
      namespace: "mygroup",
      project: "myrepo",
      noteable_type: "issue",
      noteable_iid: 1,
      body: "hello",
    });
    expect(r.status).toBe("escalate");
    expect((r as { action: string }).action).toBe("add_note");
  });

  it("create_release escalates with action name in envelope", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("create_release", {
      namespace: "mygroup",
      project: "myrepo",
      tag_name: "v1.0.0",
      name: "v1.0.0",
    });
    expect(r.status).toBe("escalate");
    expect((r as { action: string }).action).toBe("create_release");
  });

  it("trigger_pipeline escalates with action name in envelope", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("trigger_pipeline", {
      namespace: "mygroup",
      project: "myrepo",
      ref: "main",
      token: "pipeline-token",
    });
    expect(r.status).toBe("escalate");
    expect((r as { action: string }).action).toBe("trigger_pipeline");
  });
});

describe("gitlab connector — validActions", () => {
  it("exposes all 33 expected action names", () => {
    const c = buildGitlabConnector({
      sdk: async () => makeClient(),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    expect([...c.validActions].sort()).toEqual([
      "add_note",
      "cancel_pipeline",
      "close_issue",
      "close_merge_request",
      "create_issue",
      "create_merge_request",
      "create_release",
      "delete_note",
      "delete_release",
      "delete_release_link",
      "get_file",
      "get_issue",
      "get_issues",
      "get_job_logs",
      "get_merge_request",
      "get_merge_requests",
      "get_notes",
      "get_pipeline",
      "get_release_link",
      "list_pipeline_jobs",
      "list_pipelines",
      "list_release_links",
      "merge_merge_request",
      "play_job",
      "project_info",
      "retry_failed_jobs",
      "retry_pipeline",
      "search_code",
      "trigger_pipeline",
      "update_issue",
      "update_merge_request",
      "update_note",
      "update_release",
    ]);
  });
});

describe("gitlab connector — plumbing", () => {
  it("reading action (project_info) returns successful envelope", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({
        id: 1,
        name: "myrepo",
        path_with_namespace: "mygroup/myrepo",
        default_branch: "main",
        description: "test",
        visibility: "private",
        web_url: "https://gitlab.com/mygroup/myrepo",
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("project_info", {
      namespace: "mygroup",
      project: "myrepo",
    });
    expect(r.status).toBe("success");
  });

  it("unknown action returns error envelope", async () => {
    const c = makeConnector(makeClient());
    const r = await c.fetch("nonexistent_action", {});
    expect(r.status).toBe("error");
    expect((r as { error_code?: string }).error_code).toBe("VALIDATION_ERROR");
  });
});
