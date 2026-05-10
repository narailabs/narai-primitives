/**
 * Policy-gate tests for the Notion connector.
 *
 * These tests exercise the classify → checkPolicy path WITHOUT making any HTTP
 * requests. The injected `sdk` factory throws if called, so a handler that
 * reaches the Notion API will fail the test.
 *
 * Per-call policy override note: the toolkit's `fetch()` method does not
 * accept a per-call policy override — the rules are baked into the connector
 * instance at `createConnector()` time via `defaultPolicy`. To test a
 * non-default policy (e.g. `write: "success"`), construct a fresh connector
 * with the desired `defaultPolicy`. Per-call override behaviour is tested at
 * the toolkit level (tests/toolkit/policy_gate.test.ts).
 */
import { describe, expect, it } from "vitest";
import { buildNotionConnector } from "../../../src/connectors/notion/index.js";
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
  return buildNotionConnector({
    sdk: async () => neverSdk() as never,
    credentials: async () => ({ token: "secret_test" }),
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

const VALID_PAGE_ID = "a1b2c3d4-e5f6-7890-1234-567890123456";
const VALID_BLOCK_ID = "b1b2c3d4-e5f6-7890-1234-567890123456";
const VALID_DB_ID = "c1b2c3d4-e5f6-7890-1234-567890123456";

describe("Notion connector — policy gate", () => {
  it("read action (search) with default policy → success envelope", async () => {
    // Default policy has read: "success", so we need a working SDK stub.
    const readConnector = buildNotionConnector({
      sdk: async () =>
        ({
          workspaceId: null,
          search: async () => ({
            ok: true,
            status: 200,
            data: { results: [], has_more: false },
          }),
        }) as never,
      credentials: async () => ({ token: "secret_test" }),
    });
    const r = await readConnector.fetch("search", { query: "hello" });
    expect(r.status).toBe("success");
  });

  it("write action (create_page) with default policy → escalate envelope (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("create_page", {
      parent: { type: "page_id", page_id: VALID_PAGE_ID },
      properties: {},
    });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action (archive_page) with default policy → escalate envelope", async () => {
    // Default policy has no aspect override for 'delete', so the kind rule
    // (write: escalate) applies.
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("archive_page", { page_id: VALID_PAGE_ID });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action (delete_block) with default policy → escalate envelope", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("delete_block", { block_id: VALID_BLOCK_ID });
    expect(r.status).toBe("escalate");
  });

  it("delete-aspect action with aspects.delete: denied → denied envelope", async () => {
    const c = makeConnectorWithPolicy({
      aspects: { delete: "denied" },
    });
    const r = await c.fetch("archive_page", { page_id: VALID_PAGE_ID });
    expect(r.status).toBe("denied");
  });

  it("delete_block with aspects.delete: denied → denied envelope", async () => {
    const c = makeConnectorWithPolicy({
      aspects: { delete: "denied" },
    });
    const r = await c.fetch("delete_block", { block_id: VALID_BLOCK_ID });
    expect(r.status).toBe("denied");
  });

  it("write action with policy write: success → reaches handler (sdk called)", async () => {
    const sdkCalled: string[] = [];
    const writeConnector = buildNotionConnector({
      sdk: async () =>
        ({
          workspaceId: null,
          createPage: async () => {
            sdkCalled.push("createPage");
            return {
              ok: true,
              status: 200,
              data: {
                id: "new-page-id",
                url: "https://notion.so/new-page",
                created_time: "2026-01-01T00:00:00Z",
              },
            };
          },
        }) as never,
      credentials: async () => ({ token: "secret_test" }),
      defaultPolicy: { read: "success", write: "success", admin: "denied" },
    });
    const r = await writeConnector.fetch("create_page", {
      parent: { type: "page_id", page_id: VALID_PAGE_ID },
      properties: {},
    });
    expect(r.status).toBe("success");
    expect(sdkCalled).toContain("createPage");
  });

  it("append_blocks with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("append_blocks", {
      block_id: VALID_BLOCK_ID,
      children: { format: "markdown", value: "# Hello" },
    });
    expect(r.status).toBe("escalate");
  });

  it("create_database_entry with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("create_database_entry", {
      database_id: VALID_DB_ID,
      properties: { Name: { title: [{ text: { content: "Row" } }] } },
    });
    expect(r.status).toBe("escalate");
  });

  it("update_database_entry with default policy → escalate (sdk never called)", async () => {
    const c = makeConnectorWithPolicy();
    const r = await c.fetch("update_database_entry", {
      page_id: VALID_PAGE_ID,
      properties: { Status: { select: { name: "Done" } } },
    });
    expect(r.status).toBe("escalate");
  });
});
