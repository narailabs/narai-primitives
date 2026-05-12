/**
 * Tests for gitlab/actions/notes.ts — classification, schema validation,
 * and handler envelope shape for add_note, update_note, delete_note.
 */
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "narai-primitives/toolkit";
import { buildNotesActions } from "../../../../src/connectors/gitlab/actions/notes.js";
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

const noteStub = {
  id: 42,
  body: "Hello world",
  author: { username: "alice" },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  system: false,
};

// ── Classification ────────────────────────────────────────────────────────────

describe("buildNotesActions — classification", () => {
  const actions = buildNotesActions(deps);

  it("add_note is write", () => {
    expect(actions["add_note"]?.classify).toEqual({ kind: "write" });
  });

  it("update_note is write", () => {
    expect(actions["update_note"]?.classify).toEqual({ kind: "write" });
  });

  it("delete_note is write with aspects: ['delete']", () => {
    expect(actions["delete_note"]?.classify).toEqual({
      kind: "write",
      aspects: ["delete"],
    });
  });
});

// ── Schema: position requires merge_request ───────────────────────────────────

describe("add_note — schema validation", () => {
  const actions = buildNotesActions(deps);
  const spec = actions["add_note"]!;

  it("rejects position when noteable_type is 'issue'", () => {
    expect(() =>
      spec.params.parse({
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 1,
        body: "comment",
        position: {
          base_sha: "aabbccd",
          start_sha: "aabbccd",
          head_sha: "aabbccd",
          position_type: "text",
          new_path: "src/file.ts",
          new_line: 10,
        },
      }),
    ).toThrow("position is only valid when noteable_type is 'merge_request'");
  });

  it("accepts position when noteable_type is 'merge_request'", () => {
    const parsed = spec.params.parse({
      namespace: "mygroup",
      project: "myproject",
      noteable_type: "merge_request",
      noteable_iid: 5,
      body: "diff comment",
      position: {
        base_sha: "aabbccd",
        start_sha: "aabbccd",
        head_sha: "aabbccd",
        position_type: "text",
        new_path: "src/file.ts",
        new_line: 10,
      },
    });
    expect(parsed).toMatchObject({ noteable_type: "merge_request", body: "diff comment" });
  });

  it("accepts body-only note with no position for 'issue'", () => {
    const parsed = spec.params.parse({
      namespace: "mygroup",
      project: "myproject",
      noteable_type: "issue",
      noteable_iid: 3,
      body: "plain comment",
    });
    expect(parsed).toMatchObject({ noteable_type: "issue", body: "plain comment" });
  });

  it("rejects empty body", () => {
    expect(() =>
      spec.params.parse({
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 1,
        body: "",
      }),
    ).toThrow();
  });
});

// ── add_note — handler ────────────────────────────────────────────────────────

describe("add_note — handler", () => {
  const actions = buildNotesActions(deps);
  const spec = actions["add_note"]!;

  it("calls addNote and returns note envelope (issue)", async () => {
    const sdk = fakeSdk({
      addNote: async () => ({ ok: true, status: 201, data: noteStub }),
    });
    const result = await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 3,
        body: "Hello world",
      },
      sdk,
    );
    expect(result).toEqual({
      id: 42,
      body: "Hello world",
      author: "alice",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
  });

  it("calls addNote and returns note envelope (merge_request)", async () => {
    const sdk = fakeSdk({
      addNote: async () => ({ ok: true, status: 201, data: noteStub }),
    });
    const result = await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "merge_request",
        noteable_iid: 5,
        body: "Hello world",
      },
      sdk,
    );
    expect(result).toMatchObject({ id: 42, body: "Hello world" });
  });

  it("passes position payload when provided (merge_request)", async () => {
    let capturedBody: unknown;
    const sdk = fakeSdk({
      addNote: async (_ns, _proj, _type, _iid, body) => {
        capturedBody = body;
        return { ok: true, status: 201, data: noteStub };
      },
    });
    await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "merge_request",
        noteable_iid: 5,
        body: "diff comment",
        position: {
          base_sha: "aabbccd",
          start_sha: "aabbccd",
          head_sha: "aabbccd",
          position_type: "text",
          new_path: "src/file.ts",
          new_line: 10,
        },
      },
      sdk,
    );
    expect((capturedBody as Record<string, unknown>)["position"]).toBeDefined();
  });

  it("throws on HTTP error", async () => {
    const sdk = fakeSdk({
      addNote: async () => ({ ok: false, status: 403, data: null }),
    });
    await expect(
      runHandler(
        spec,
        {
          namespace: "mygroup",
          project: "myproject",
          noteable_type: "issue",
          noteable_iid: 1,
          body: "comment",
        },
        sdk,
      ),
    ).rejects.toThrow();
  });
});

// ── update_note — schema ──────────────────────────────────────────────────────

describe("update_note — schema validation", () => {
  const actions = buildNotesActions(deps);
  const spec = actions["update_note"]!;

  it("rejects discussion_id when noteable_type is 'issue'", () => {
    expect(() =>
      spec.params.parse({
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 1,
        note_id: 42,
        body: "text",
        discussion_id: "disc-abc",
      }),
    ).toThrow("discussion_id is only valid when noteable_type is 'merge_request'");
  });

  it("accepts discussion_id when noteable_type is 'merge_request'", () => {
    const parsed = spec.params.parse({
      namespace: "mygroup",
      project: "myproject",
      noteable_type: "merge_request",
      noteable_iid: 5,
      note_id: 42,
      body: "text",
      discussion_id: "disc-abc",
    });
    expect(parsed).toMatchObject({ discussion_id: "disc-abc" });
  });
});

// ── update_note — handler ─────────────────────────────────────────────────────

describe("update_note — handler", () => {
  const actions = buildNotesActions(deps);
  const spec = actions["update_note"]!;

  it("calls updateNote and returns updated envelope (issue)", async () => {
    const sdk = fakeSdk({
      updateNote: async () => ({
        ok: true,
        status: 200,
        data: { ...noteStub, body: "Updated" },
      }),
    });
    const result = await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 3,
        note_id: 42,
        body: "Updated",
      },
      sdk,
    );
    expect(result).toMatchObject({ id: 42, body: "Updated" });
  });

  it("calls updateNote and returns updated envelope (merge_request)", async () => {
    const sdk = fakeSdk({
      updateNote: async () => ({
        ok: true,
        status: 200,
        data: { ...noteStub, body: "MR updated" },
      }),
    });
    const result = await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "merge_request",
        noteable_iid: 5,
        note_id: 42,
        body: "MR updated",
      },
      sdk,
    );
    expect(result).toMatchObject({ body: "MR updated" });
  });

  it("passes discussion_id to sdk.updateNote when provided", async () => {
    let capturedOpts: unknown;
    const sdk = fakeSdk({
      updateNote: async (_ns, _proj, _type, _iid, _noteId, _body, opts) => {
        capturedOpts = opts;
        return { ok: true, status: 200, data: noteStub };
      },
    });
    await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "merge_request",
        noteable_iid: 5,
        note_id: 42,
        body: "Updated",
        discussion_id: "disc-abc",
      },
      sdk,
    );
    expect((capturedOpts as Record<string, unknown>)["discussionId"]).toBe("disc-abc");
  });

  it("throws on HTTP error", async () => {
    const sdk = fakeSdk({
      updateNote: async () => ({ ok: false, status: 404, data: null }),
    });
    await expect(
      runHandler(
        spec,
        {
          namespace: "mygroup",
          project: "myproject",
          noteable_type: "issue",
          noteable_iid: 3,
          note_id: 99,
          body: "Updated",
        },
        sdk,
      ),
    ).rejects.toThrow();
  });
});

// ── delete_note — schema ──────────────────────────────────────────────────────

describe("delete_note — schema validation", () => {
  const actions = buildNotesActions(deps);
  const spec = actions["delete_note"]!;

  it("rejects discussion_id when noteable_type is 'issue'", () => {
    expect(() =>
      spec.params.parse({
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 1,
        note_id: 42,
        discussion_id: "disc-abc",
      }),
    ).toThrow("discussion_id is only valid when noteable_type is 'merge_request'");
  });

  it("accepts discussion_id when noteable_type is 'merge_request'", () => {
    const parsed = spec.params.parse({
      namespace: "mygroup",
      project: "myproject",
      noteable_type: "merge_request",
      noteable_iid: 5,
      note_id: 42,
      discussion_id: "disc-abc",
    });
    expect(parsed).toMatchObject({ discussion_id: "disc-abc" });
  });
});

// ── delete_note — handler ─────────────────────────────────────────────────────

describe("delete_note — handler", () => {
  const actions = buildNotesActions(deps);
  const spec = actions["delete_note"]!;

  it("calls deleteNote and returns { note_id, deleted: true } (issue)", async () => {
    const sdk = fakeSdk({
      deleteNote: async () => ({ ok: true, status: 204, data: null }),
    });
    const result = await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "issue",
        noteable_iid: 3,
        note_id: 42,
      },
      sdk,
    );
    expect(result).toEqual({ note_id: 42, deleted: true });
  });

  it("calls deleteNote and returns { note_id, deleted: true } (merge_request)", async () => {
    const sdk = fakeSdk({
      deleteNote: async () => ({ ok: true, status: 204, data: null }),
    });
    const result = await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "merge_request",
        noteable_iid: 5,
        note_id: 7,
      },
      sdk,
    );
    expect(result).toEqual({ note_id: 7, deleted: true });
  });

  it("passes discussion_id to sdk.deleteNote when provided", async () => {
    let capturedOpts: unknown;
    const sdk = fakeSdk({
      deleteNote: async (_ns, _proj, _type, _iid, _noteId, opts) => {
        capturedOpts = opts;
        return { ok: true, status: 204, data: null };
      },
    });
    await runHandler(
      spec,
      {
        namespace: "mygroup",
        project: "myproject",
        noteable_type: "merge_request",
        noteable_iid: 5,
        note_id: 7,
        discussion_id: "disc-xyz",
      },
      sdk,
    );
    expect((capturedOpts as Record<string, unknown>)["discussionId"]).toBe("disc-xyz");
  });

  it("throws on HTTP error", async () => {
    const sdk = fakeSdk({
      deleteNote: async () => ({ ok: false, status: 403, data: null }),
    });
    await expect(
      runHandler(
        spec,
        {
          namespace: "mygroup",
          project: "myproject",
          noteable_type: "issue",
          noteable_iid: 3,
          note_id: 42,
        },
        sdk,
      ),
    ).rejects.toThrow();
  });
});
