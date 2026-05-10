/**
 * Policy-gate tests for the Confluence connector.
 *
 * These tests exercise the classify → checkPolicy path WITHOUT making any HTTP
 * requests. The injected `sdk` factory throws if called, so a handler that
 * reaches the Confluence API will fail the test.
 *
 * Per-call policy override note: the toolkit's `fetch()` method does not
 * accept a per-call policy override — the rules are baked into the connector
 * instance at `createConnector()` time via `defaultPolicy`. To test a
 * non-default policy (e.g. `write: "success"`), construct a fresh connector
 * with the desired `defaultPolicy`. Per-call override behaviour is tested at
 * the toolkit level (tests/toolkit/policy_gate.test.ts).
 */
import { describe, expect, it } from "vitest";
import { buildConfluenceConnector } from "../../../src/connectors/confluence/index.js";
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
  return buildConfluenceConnector({
    sdk: async () => neverSdk() as never,
    credentials: async () => ({ email: "u@example.com" }),
    ...(policy !== undefined
      ? { defaultPolicy: { read: "success", write: "escalate", admin: "denied", ...policy } }
      : {}),
  });
}

describe("Confluence connector — policy gate", () => {
  it("read action (get_page) with default policy → success envelope", async () => {
    // Default policy has read: "success", so we need a working SDK stub.
    const readConnector = buildConfluenceConnector({
      sdk: async () =>
        ({
          siteUrl: "https://example.atlassian.net",
          getContent: async () => ({
            ok: true,
            status: 200,
            data: {
              id: "123",
              title: "Test Page",
              space: { key: "DEV" },
              version: { number: 1, when: "2026-01-01" },
              body: { storage: { value: "hello" } },
            },
          }),
        }) as never,
      credentials: async () => ({ email: "u@example.com" }),
    });
    const r = await readConnector.fetch("get_page", { page_id: "123" });
    expect(r.status).toBe("success");
  });

  it("write action (create_page) with default policy → escalate envelope (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("create_page", {
      space_key: "DEV",
      title: "New Page",
      body: { format: "plain", value: "hello" },
    });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action (delete_page) with default policy → escalate envelope", async () => {
    // Default policy has no aspect override for 'delete', so the kind rule
    // (write: escalate) applies.
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("delete_page", { page_id: "123" });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action with aspects.delete: denied → denied envelope", async () => {
    const c = makeConnectorWithPolicy({
      aspects: { delete: "denied" },
    });
    const r = await c.fetch("delete_page", { page_id: "123" });
    expect(r.status).toBe("denied");
  });

  it("write action with policy write: success → reaches handler (sdk called)", async () => {
    const sdkCalled: string[] = [];
    const writeConnector = buildConfluenceConnector({
      sdk: async () =>
        ({
          siteUrl: "https://example.atlassian.net",
          createPage: async () => {
            sdkCalled.push("createPage");
            return {
              ok: true,
              status: 200,
              data: { id: "999", title: "New Page", version: { number: 1 } },
            };
          },
        }) as never,
      credentials: async () => ({ email: "u@example.com" }),
      defaultPolicy: { read: "success", write: "success", admin: "denied" },
    });
    const r = await writeConnector.fetch("create_page", {
      space_key: "DEV",
      title: "New Page",
      body: { format: "plain", value: "hello" },
    });
    expect(r.status).toBe("success");
    expect(sdkCalled).toContain("createPage");
  });

  it("add_comment with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("add_comment", {
      page_id: "123",
      body: { format: "plain", value: "hi" },
    });
    expect(r.status).toBe("escalate");
  });

  it("update_page with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("update_page", {
      page_id: "123",
      title: "Updated",
      body: { format: "plain", value: "new content" },
      expected_version: 1,
    });
    expect(r.status).toBe("escalate");
  });

  it("post_attachment with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("post_attachment", {
      page_id: "123",
      files: [
        {
          filename: "doc.txt",
          content_base64: Buffer.from("hi").toString("base64"),
        },
      ],
    });
    expect(r.status).toBe("escalate");
  });
});
