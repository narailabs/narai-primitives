/**
 * Policy-gate tests for the Linear connector.
 *
 * These tests exercise the classify → checkPolicy path WITHOUT making any HTTP
 * requests. The injected `sdk` factory throws if called, so a handler that
 * reaches the Linear API will fail the test.
 */
import { describe, expect, it } from "vitest";
import { buildLinearConnector } from "../../../src/connectors/linear/index.js";
import type { PolicyRules } from "../../../src/toolkit/policy/types.js";

/** Stub SDK that throws if any method is invoked — guards against handler execution. */
function neverSdk() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return () => {
          throw new Error(`SDK method '${String(prop)}' called unexpectedly`);
        };
      },
    },
  );
}

function makeConnectorWithPolicy(policy?: Partial<PolicyRules>) {
  return buildLinearConnector({
    sdk: async () => neverSdk() as never,
    credentials: async () => ({ api_key: "lin_test_key" }),
    ...(policy !== undefined
      ? {
          defaultPolicy: {
            read: "success",
            write: "escalate",
            admin: "denied",
            ...policy,
          },
        }
      : {}),
  });
}

const VALID_ISSUE_ID = "ENG-123";
const VALID_UUID = "a1b2c3d4e5f678901234567890123456";
const VALID_TEAM_KEY = "ENG";

describe("Linear connector — policy gate", () => {
  it("read action (get_issue) with default policy → success envelope (sdk called)", async () => {
    const readConnector = buildLinearConnector({
      sdk: async () =>
        ({
          getIssue: async () => ({
            ok: true,
            status: 200,
            data: {
              issue: {
                id: VALID_UUID,
                identifier: "ENG-123",
                title: "Test issue",
                description: null,
                priority: 2,
                url: "https://linear.app/team/issue/ENG-123",
                archivedAt: null,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                state: { id: "state-id", name: "Todo", type: "unstarted" },
                assignee: null,
                team: { id: "team-id", key: "ENG", name: "Engineering" },
                labels: { nodes: [] },
              },
            },
          }),
        }) as never,
      credentials: async () => ({ api_key: "lin_test_key" }),
    });
    const r = await readConnector.fetch("get_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("success");
  });

  it("write action (create_issue) with default policy → escalate envelope (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("create_issue", {
      team_id: VALID_UUID,
      title: "New issue",
    });
    expect(r.status).toBe("escalate");
  });

  it("write action (update_issue) with default policy → escalate envelope", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("update_issue", {
      id: VALID_ISSUE_ID,
      title: "Updated title",
    });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action (archive_issue) with default policy → escalate envelope", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("archive_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action (delete_comment) with default policy → escalate envelope", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("delete_comment", { comment_id: VALID_UUID });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action with aspects.delete: denied → denied envelope (archive_issue)", async () => {
    const c = makeConnectorWithPolicy({
      aspects: { delete: "denied" },
    });
    const r = await c.fetch("archive_issue", { id: VALID_ISSUE_ID });
    expect(r.status).toBe("denied");
  });

  it("delete_comment with aspects.delete: denied → denied envelope", async () => {
    const c = makeConnectorWithPolicy({
      aspects: { delete: "denied" },
    });
    const r = await c.fetch("delete_comment", { comment_id: VALID_UUID });
    expect(r.status).toBe("denied");
  });

  it("write action with policy write: success → reaches handler (sdk called)", async () => {
    const sdkCalled: string[] = [];
    const writeConnector = buildLinearConnector({
      sdk: async () =>
        ({
          createIssue: async () => {
            sdkCalled.push("createIssue");
            return {
              ok: true,
              status: 200,
              data: {
                issueCreate: {
                  success: true,
                  issue: {
                    id: VALID_UUID,
                    identifier: "ENG-1",
                    url: "https://linear.app/team/issue/ENG-1",
                    title: "New issue",
                    createdAt: "2026-01-01T00:00:00Z",
                  },
                },
              },
            };
          },
        }) as never,
      credentials: async () => ({ api_key: "lin_test_key" }),
      defaultPolicy: { read: "success", write: "success", admin: "denied" },
    });
    const r = await writeConnector.fetch("create_issue", {
      team_id: VALID_UUID,
      title: "New issue",
    });
    expect(r.status).toBe("success");
    expect(sdkCalled).toContain("createIssue");
  });

  it("add_comment with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("add_comment", {
      issue_id: VALID_ISSUE_ID,
      body: "Hello world",
    });
    expect(r.status).toBe("escalate");
  });

  it("attachment_link with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("attachment_link", {
      issue_id: VALID_ISSUE_ID,
      title: "Design doc",
      url: "https://example.com/doc",
    });
    expect(r.status).toBe("escalate");
  });
});
