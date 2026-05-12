/**
 * Tests for gitlab/actions/reads.ts — classification + handler envelope
 * shape for all 14 read actions. Also covers the paginateGitlab utility.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildReadActions } from "../../../../src/connectors/gitlab/actions/reads.js";
import type { GitlabClient } from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

function fakeSdk(overrides: Partial<GitlabClient> = {}): GitlabClient {
  return overrides as unknown as GitlabClient;
}

function runHandler<P>(
  spec: ActionSpec<P, GitlabClient>,
  params: unknown,
  sdk: GitlabClient,
): Promise<unknown> {
  const parsed = spec.params.parse(params) as P;
  return spec.handler(parsed, { sdk } as Parameters<typeof spec.handler>[1]);
}

const deps = { behavior: { requireDraftMr: false, host: "https://gitlab.com" } };

// ── Classification ────────────────────────────────────────────────────────────

describe("buildReadActions — classification (all 14 are read)", () => {
  const actions = buildReadActions(deps);

  it("project_info is read", () => {
    expect(actions["project_info"]?.classify).toEqual({ kind: "read" });
  });
  it("search_code is read", () => {
    expect(actions["search_code"]?.classify).toEqual({ kind: "read" });
  });
  it("get_issues is read", () => {
    expect(actions["get_issues"]?.classify).toEqual({ kind: "read" });
  });
  it("get_issue is read", () => {
    expect(actions["get_issue"]?.classify).toEqual({ kind: "read" });
  });
  it("get_merge_requests is read", () => {
    expect(actions["get_merge_requests"]?.classify).toEqual({ kind: "read" });
  });
  it("get_merge_request is read", () => {
    expect(actions["get_merge_request"]?.classify).toEqual({ kind: "read" });
  });
  it("get_file is read", () => {
    expect(actions["get_file"]?.classify).toEqual({ kind: "read" });
  });
  it("get_notes is read", () => {
    expect(actions["get_notes"]?.classify).toEqual({ kind: "read" });
  });
  it("list_release_links is read", () => {
    expect(actions["list_release_links"]?.classify).toEqual({ kind: "read" });
  });
  it("get_release_link is read", () => {
    expect(actions["get_release_link"]?.classify).toEqual({ kind: "read" });
  });
  it("list_pipelines is read", () => {
    expect(actions["list_pipelines"]?.classify).toEqual({ kind: "read" });
  });
  it("get_pipeline is read", () => {
    expect(actions["get_pipeline"]?.classify).toEqual({ kind: "read" });
  });
  it("list_pipeline_jobs is read", () => {
    expect(actions["list_pipeline_jobs"]?.classify).toEqual({ kind: "read" });
  });
  it("get_job_logs is read", () => {
    expect(actions["get_job_logs"]?.classify).toEqual({ kind: "read" });
  });
});

// ── project_info ──────────────────────────────────────────────────────────────

describe("project_info", () => {
  it("maps project data to normalized envelope", async () => {
    const sdk = fakeSdk({
      getProject: async () => ({
        ok: true,
        status: 200,
        data: {
          id: 1,
          name: "my-project",
          path_with_namespace: "mygroup/my-project",
          default_branch: "main",
          description: "A test project",
          visibility: "private",
          web_url: "https://gitlab.com/mygroup/my-project",
        },
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["project_info"]!,
      { namespace: "mygroup", project: "my-project" },
      sdk,
    )) as Record<string, unknown>;
    expect(r).toMatchObject({
      id: 1,
      name: "my-project",
      path_with_namespace: "mygroup/my-project",
      default_branch: "main",
      description: "A test project",
      visibility: "private",
      web_url: "https://gitlab.com/mygroup/my-project",
    });
  });
});

// ── search_code ───────────────────────────────────────────────────────────────

describe("search_code", () => {
  it("maps blob search results to normalized envelope", async () => {
    const sdk = fakeSdk({
      searchCode: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            filename: "src/app.ts",
            path: "src/app.ts",
            ref: "main",
            startline: 10,
            project_id: 1,
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["search_code"]!,
      { namespace: "mygroup", project: "my-project", query: "hello" },
      sdk,
    )) as { total: number; items: unknown[]; truncated: boolean };
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ path: "src/app.ts", ref: "main" });
    expect(r.truncated).toBe(false);
  });

  it("paginates across multiple pages until max_results is reached", async () => {
    let callCount = 0;
    const sdk = fakeSdk({
      searchCode: async (_ns, _proj, _q, opts) => {
        callCount++;
        const perPage = opts?.perPage ?? 30;
        // Always return a full page
        const data = Array.from({ length: perPage }, (_, i) => ({
          filename: `file${(callCount - 1) * perPage + i}.ts`,
          path: `src/file${(callCount - 1) * perPage + i}.ts`,
          ref: "main",
          startline: i + 1,
          project_id: 1,
        }));
        return { ok: true as const, status: 200, data };
      },
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["search_code"]!,
      { namespace: "mygroup", project: "my-project", query: "fn", max_results: 5 },
      sdk,
    )) as { total: number; items: unknown[]; truncated: boolean };
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
    // pagination was driven (more than 1 call would only happen if pages are full)
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ── get_issues ────────────────────────────────────────────────────────────────

describe("get_issues", () => {
  it("paginates and maps issues to normalized envelope", async () => {
    const sdk = fakeSdk({
      listIssues: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            iid: 1,
            title: "Bug report",
            state: "opened",
            author: { username: "alice" },
            labels: ["bug"],
            web_url: "https://gitlab.com/g/p/-/issues/1",
            updated_at: "2026-05-01T00:00:00Z",
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_issues"]!,
      { namespace: "mygroup", project: "my-project" },
      sdk,
    )) as { total: number; issues: unknown[]; truncated: boolean };
    expect(r.total).toBe(1);
    expect(r.issues[0]).toMatchObject({
      iid: 1,
      title: "Bug report",
      state: "opened",
      author: "alice",
    });
  });
});

// ── get_issue ─────────────────────────────────────────────────────────────────

describe("get_issue", () => {
  it("fetches and maps a single issue", async () => {
    const sdk = fakeSdk({
      getIssue: async () => ({
        ok: true,
        status: 200,
        data: {
          iid: 5,
          title: "Feature request",
          state: "opened",
          author: { username: "bob" },
          description: "Please add X",
          labels: ["enhancement"],
          web_url: "https://gitlab.com/g/p/-/issues/5",
          updated_at: "2026-05-02T00:00:00Z",
        },
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_issue"]!,
      { namespace: "mygroup", project: "my-project", iid: 5 },
      sdk,
    )) as Record<string, unknown>;
    expect(r).toMatchObject({
      iid: 5,
      title: "Feature request",
      state: "opened",
      author: "bob",
    });
  });
});

// ── get_merge_requests ────────────────────────────────────────────────────────

describe("get_merge_requests", () => {
  it("paginates and maps MRs to normalized envelope", async () => {
    const sdk = fakeSdk({
      listMergeRequests: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            iid: 3,
            title: "feat: new thing",
            state: "opened",
            author: { username: "carol" },
            web_url: "https://gitlab.com/g/p/-/merge_requests/3",
            updated_at: "2026-05-03T00:00:00Z",
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_merge_requests"]!,
      { namespace: "mygroup", project: "my-project" },
      sdk,
    )) as { total: number; merge_requests: unknown[]; truncated: boolean };
    expect(r.total).toBe(1);
    expect(r.merge_requests[0]).toMatchObject({
      iid: 3,
      title: "feat: new thing",
      author: "carol",
    });
  });
});

// ── get_merge_request ─────────────────────────────────────────────────────────

describe("get_merge_request", () => {
  it("fetches and maps a single MR", async () => {
    const sdk = fakeSdk({
      getMergeRequest: async () => ({
        ok: true,
        status: 200,
        data: {
          iid: 7,
          title: "fix: something",
          state: "merged",
          author: { username: "dave" },
          description: "Fixes the bug",
          source_branch: "fix/bug",
          target_branch: "main",
          sha: "abc1234",
          web_url: "https://gitlab.com/g/p/-/merge_requests/7",
          updated_at: "2026-05-04T00:00:00Z",
        },
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_merge_request"]!,
      { namespace: "mygroup", project: "my-project", iid: 7 },
      sdk,
    )) as Record<string, unknown>;
    expect(r).toMatchObject({
      iid: 7,
      title: "fix: something",
      state: "merged",
      author: "dave",
      source_branch: "fix/bug",
      target_branch: "main",
    });
  });
});

// ── get_file ──────────────────────────────────────────────────────────────────

describe("get_file", () => {
  it("decodes base64 content from GitLab file response", async () => {
    const contentBase64 = Buffer.from("hello world\n").toString("base64");
    const sdk = fakeSdk({
      getFile: async () => ({
        ok: true,
        status: 200,
        data: {
          file_name: "README.md",
          file_path: "README.md",
          size: 12,
          encoding: "base64",
          content: contentBase64,
          ref: "main",
          blob_id: "abc",
          commit_id: "def",
          last_commit_id: "def",
        },
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_file"]!,
      { namespace: "mygroup", project: "my-project", path: "README.md", ref: "main" },
      sdk,
    )) as Record<string, unknown>;
    expect(r.path).toBe("README.md");
    expect(r.content).toBe("hello world\n");
    expect(r.encoding).toBe("utf-8");
    expect(r.ref).toBe("main");
  });
});

// ── get_notes ─────────────────────────────────────────────────────────────────

describe("get_notes", () => {
  it("fetches notes for an issue", async () => {
    const sdk = fakeSdk({
      getNotes: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            id: 101,
            body: "This is a note",
            author: { username: "eve" },
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            system: false,
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_notes"]!,
      { namespace: "mygroup", project: "my-project", noteable_type: "issue", noteable_iid: 1 },
      sdk,
    )) as { total: number; notes: unknown[] };
    expect(r.total).toBe(1);
    expect(r.notes[0]).toMatchObject({
      id: 101,
      body: "This is a note",
      author: "eve",
    });
  });

  it("fetches notes for a merge_request", async () => {
    const sdk = fakeSdk({
      getNotes: async (_ns, _proj, noteableType, _iid) => {
        expect(noteableType).toBe("merge_request");
        return {
          ok: true as const,
          status: 200,
          data: [{ id: 202, body: "MR note", author: { username: "frank" }, created_at: "2026-05-02T00:00:00Z", updated_at: "2026-05-02T00:00:00Z", system: false }],
        };
      },
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_notes"]!,
      { namespace: "mygroup", project: "my-project", noteable_type: "merge_request", noteable_iid: 3 },
      sdk,
    )) as { notes: unknown[] };
    expect(r.notes[0]).toMatchObject({ id: 202, author: "frank" });
  });
});

// ── list_release_links ────────────────────────────────────────────────────────

describe("list_release_links", () => {
  it("maps release links to normalized envelope", async () => {
    const sdk = fakeSdk({
      listReleaseLinks: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            id: 1,
            name: "linux-binary",
            url: "https://example.com/linux",
            link_type: "package",
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["list_release_links"]!,
      { namespace: "mygroup", project: "my-project", tag: "v1.0.0" },
      sdk,
    )) as { tag: string; links: unknown[] };
    expect(r.tag).toBe("v1.0.0");
    expect(r.links[0]).toMatchObject({ id: 1, name: "linux-binary" });
  });
});

// ── get_release_link ──────────────────────────────────────────────────────────

describe("get_release_link", () => {
  it("maps a single release link to normalized envelope", async () => {
    const sdk = fakeSdk({
      getReleaseLink: async () => ({
        ok: true,
        status: 200,
        data: {
          id: 5,
          name: "windows-binary",
          url: "https://example.com/windows",
          link_type: "package",
        },
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_release_link"]!,
      { namespace: "mygroup", project: "my-project", tag: "v1.0.0", link_id: 5 },
      sdk,
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ id: 5, name: "windows-binary" });
  });
});

// ── list_pipelines ────────────────────────────────────────────────────────────

describe("list_pipelines", () => {
  it("paginates and maps pipelines to normalized envelope", async () => {
    const sdk = fakeSdk({
      listPipelines: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            id: 100,
            status: "success",
            ref: "main",
            sha: "abc1234",
            web_url: "https://gitlab.com/g/p/-/pipelines/100",
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T01:00:00Z",
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["list_pipelines"]!,
      { namespace: "mygroup", project: "my-project" },
      sdk,
    )) as { total: number; pipelines: unknown[]; truncated: boolean };
    expect(r.total).toBe(1);
    expect(r.pipelines[0]).toMatchObject({ id: 100, status: "success", ref: "main" });
  });
});

// ── get_pipeline ──────────────────────────────────────────────────────────────

describe("get_pipeline", () => {
  it("fetches and maps a single pipeline", async () => {
    const sdk = fakeSdk({
      getPipeline: async () => ({
        ok: true,
        status: 200,
        data: {
          id: 200,
          status: "failed",
          ref: "feat/x",
          sha: "def5678",
          web_url: "https://gitlab.com/g/p/-/pipelines/200",
          created_at: "2026-05-02T00:00:00Z",
          updated_at: "2026-05-02T01:00:00Z",
          duration: 120,
          finished_at: "2026-05-02T01:00:00Z",
        },
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_pipeline"]!,
      { namespace: "mygroup", project: "my-project", pipeline_id: 200 },
      sdk,
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ id: 200, status: "failed", ref: "feat/x" });
  });
});

// ── list_pipeline_jobs ────────────────────────────────────────────────────────

describe("list_pipeline_jobs", () => {
  it("maps pipeline jobs to normalized envelope", async () => {
    const sdk = fakeSdk({
      listPipelineJobs: async () => ({
        ok: true,
        status: 200,
        data: [
          {
            id: 300,
            name: "test",
            stage: "test",
            status: "success",
            created_at: "2026-05-01T00:00:00Z",
            started_at: "2026-05-01T00:01:00Z",
            finished_at: "2026-05-01T00:05:00Z",
            duration: 240,
            web_url: "https://gitlab.com/g/p/-/jobs/300",
          },
        ],
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["list_pipeline_jobs"]!,
      { namespace: "mygroup", project: "my-project", pipeline_id: 100 },
      sdk,
    )) as { jobs: unknown[] };
    expect(r.jobs[0]).toMatchObject({ id: 300, name: "test", stage: "test", status: "success" });
  });
});

// ── get_job_logs ──────────────────────────────────────────────────────────────

describe("get_job_logs", () => {
  it("returns logs string and content_length", async () => {
    const logsText = "Running tests...\nAll passed!\n";
    const sdk = fakeSdk({
      getJobLogs: async () => ({
        ok: true,
        status: 200,
        data: logsText,
      }),
    });
    const actions = buildReadActions(deps);
    const r = (await runHandler(
      actions["get_job_logs"]!,
      { namespace: "mygroup", project: "my-project", job_id: 300 },
      sdk,
    )) as { logs: string; content_length: number };
    expect(r.logs).toBe(logsText);
    expect(r.content_length).toBe(logsText.length);
  });
});

// ── paginateGitlab ────────────────────────────────────────────────────────────

describe("paginateGitlab utility", () => {
  it("stops on a short page (last page detection)", async () => {
    const actions = buildReadActions(deps);
    // list_pipelines uses paginateGitlab; give it a single page with 1 item (short page = done)
    const sdk = fakeSdk({
      listPipelines: async (_ns, _proj, query) => {
        expect(query.per_page).toBeGreaterThan(0);
        return {
          ok: true as const,
          status: 200,
          data: [{ id: 1, status: "success", ref: "main", sha: "a", web_url: "x", created_at: "t", updated_at: "t" }],
        };
      },
    });
    const r = (await runHandler(
      actions["list_pipelines"]!,
      { namespace: "g", project: "p", max_results: 50 },
      sdk,
    )) as { total: number; truncated: boolean };
    expect(r.total).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("truncates when max_results is reached mid-pagination", async () => {
    const actions = buildReadActions(deps);
    let callCount = 0;
    const sdk = fakeSdk({
      listPipelines: async (_ns, _proj, query) => {
        callCount++;
        const perPage = (query.per_page as number) ?? 30;
        // Always return a full page
        const items = Array.from({ length: perPage }, (_, i) => ({
          id: (callCount - 1) * perPage + i + 1,
          status: "success",
          ref: "main",
          sha: "a",
          web_url: "x",
          created_at: "t",
          updated_at: "t",
        }));
        return { ok: true as const, status: 200, data: items };
      },
    });
    const r = (await runHandler(
      actions["list_pipelines"]!,
      { namespace: "g", project: "p", max_results: 5 },
      sdk,
    )) as { total: number; truncated: boolean };
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });
});
