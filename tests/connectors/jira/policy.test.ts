/**
 * Policy-gate tests for the Jira connector.
 *
 * These tests exercise the classify → checkPolicy path WITHOUT making any HTTP
 * requests. The injected `sdk` factory throws if called, so a handler that
 * reaches the Jira API will fail the test.
 *
 * Per-call policy override note: the toolkit's `fetch()` method does not
 * accept a per-call policy override — the rules are baked into the connector
 * instance at `createConnector()` time via `defaultPolicy`. To test a
 * non-default policy (e.g. `write: "success"`), construct a fresh connector
 * with the desired `defaultPolicy`. Per-call override behaviour is tested at
 * the toolkit level (tests/toolkit/policy_gate.test.ts).
 */
import { describe, expect, it } from "vitest";
import { buildJiraConnector } from "../../../src/connectors/jira/index.js";
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
  return buildJiraConnector({
    sdk: async () => neverSdk() as never,
    credentials: async () => ({ email: "u@example.com" }),
    ...(policy !== undefined ? { defaultPolicy: { read: "success", write: "escalate", admin: "denied", ...policy } } : {}),
  });
}

describe("Jira connector — policy gate", () => {
  it("read action (jql_search) with default policy → success envelope", async () => {
    const c = makeConnectorWithPolicy();
    // We need the SDK to handle the request, so provide a real-ish client.
    // Since we only care about the policy outcome we must provide a working SDK.
    // Use a stub that returns a valid JQL response for the read test.
    const readConnector = buildJiraConnector({
      sdk: async () =>
        ({
          siteUrl: "https://example.atlassian.net",
          searchJql: async () => ({
            ok: true,
            status: 200,
            data: { total: 0, issues: [], maxResults: 10, startAt: 0 },
          }),
        }) as never,
      credentials: async () => ({ email: "u@example.com" }),
    });
    const r = await readConnector.fetch("jql_search", { jql: "project = X" });
    expect(r.status).toBe("success");
  });

  it("write action (create_issue) with default policy → escalate envelope (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("create_issue", {
      project_key: "PROJ",
      issue_type: "Task",
      summary: "test",
    });
    expect(r.status).toBe("escalate");
  });

  it("write action (update_issue) with default policy → escalate envelope", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("update_issue", {
      issue_key: "PROJ-1",
      summary: "updated",
    });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect write action (delete_issue) with default policy → escalate envelope", async () => {
    // Default policy has no aspect override for 'delete', so the kind rule
    // (write: escalate) applies.
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("delete_issue", { issue_key: "PROJ-1" });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect write action with aspects.delete: denied → denied envelope", async () => {
    const c = makeConnectorWithPolicy({
      aspects: { delete: "denied" },
    });
    const r = await c.fetch("delete_issue", { issue_key: "PROJ-1" });
    expect(r.status).toBe("denied");
  });

  it("write action with policy write: success → reaches handler (sdk called)", async () => {
    const sdkCalled: string[] = [];
    const writeConnector = buildJiraConnector({
      sdk: async () =>
        ({
          siteUrl: "https://example.atlassian.net",
          createIssue: async () => {
            sdkCalled.push("createIssue");
            return {
              ok: true,
              status: 201,
              data: { key: "PROJ-1", id: "10001", self: "https://x" },
            };
          },
        }) as never,
      credentials: async () => ({ email: "u@example.com" }),
      defaultPolicy: { read: "success", write: "success", admin: "denied" },
    });
    const r = await writeConnector.fetch("create_issue", {
      project_key: "PROJ",
      issue_type: "Task",
      summary: "hello",
    });
    expect(r.status).toBe("success");
    expect(sdkCalled).toContain("createIssue");
  });

  it("add_comment with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("add_comment", {
      issue_key: "PROJ-1",
      body: { format: "plain", value: "hello" },
    });
    expect(r.status).toBe("escalate");
  });

  it("transition_issue with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("transition_issue", {
      issue_key: "PROJ-1",
      transition_id: "21",
    });
    expect(r.status).toBe("escalate");
  });
});
