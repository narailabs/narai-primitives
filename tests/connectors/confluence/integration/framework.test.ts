/**
 * Framework integration tests — exercise the new @narai/connector-toolkit
 * policy gate, hardship logger, and audit writer through the Confluence
 * connector. These are path-coverage tests, not Confluence API tests.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfluenceConnector } from "../../../../src/connectors/confluence/index.js";
import {
  ConfluenceClient,
  type ConfluenceClientOptions,
} from "../../../../src/connectors/confluence/lib/confluence_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "conf-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "conf-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
  delete process.env["CONFLUENCE_SITE_URL"];
  delete process.env["CONFLUENCE_EMAIL"];
  delete process.env["CONFLUENCE_API_TOKEN"];
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome !== undefined) process.env["HOME"] = origHome;
  else delete process.env["HOME"];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  overrides: Partial<ConfluenceClientOptions>,
  fetchMock: (url: string) => Promise<Response>,
): ConfluenceClient {
  return new ConfluenceClient({
    siteUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "tok",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url) => fetchMock(String(url)),
    sleepImpl: async () => {},
    ...overrides,
  });
}

function writeRepoPolicy(yaml: string) {
  const dir = path.join(tmpCwd, ".confluence-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("policy gate integration", () => {
  it("policy.read: escalate returns escalate envelope, handler not called", async () => {
    writeRepoPolicy("policy:\n  read: escalate\n");

    let handlerCalled = false;
    const client = makeClient({}, async () => {
      handlerCalled = true;
      return jsonResponse({ results: [], totalSize: 0 });
    });
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });

    const r = await c.fetch("cql_search", { cql: "space = DEV" });
    expect(r.status).toBe("escalate");
    if (r.status === "escalate") {
      expect(r.reason).toContain("read");
    }
    expect(handlerCalled).toBe(false);
  });

  it("policy.read: denied returns denied envelope", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient({}, async () =>
      jsonResponse({ results: [], totalSize: 0 }),
    );
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("get_space", { space_key: "DEV" });
    expect(r.status).toBe("denied");
  });

  it("unrelated write rule has no effect on read actions", async () => {
    writeRepoPolicy("policy:\n  write: denied\n  read: success\n");
    const client = makeClient({}, async () =>
      jsonResponse({
        totalSize: 0,
        results: [],
      }),
    );
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("cql_search", { cql: "x" });
    expect(r.status).toBe("success");
  });

  it("approval_mode: confirm_each escalates reads", async () => {
    writeRepoPolicy("approval_mode: confirm_each\n");
    const client = makeClient({}, async () =>
      jsonResponse({ results: [], totalSize: 0 }),
    );
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("cql_search", { cql: "x" });
    expect(r.status).toBe("escalate");
    if (r.status === "escalate") {
      expect(r.reason).toContain("confirm_each");
    }
  });
});

describe("hardship logging integration", () => {
  it("429 on search writes a JSONL hardship entry to user-global (no .claude/ in cwd)", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 429 }));
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("cql_search", { cql: "x" });
    expect(r.status).toBe("error");

    // No project-local .claude/ in tmpCwd, so hardship goes to user-tenant tier.
    // Toolkit 3.0 uses tiered layout; scope = ctx.sdk.siteUrl hashed to 16-char hex.
    // sha16("https://example.atlassian.net") === "b6a8e8d4e9d9a4ea"
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "confluence",
      "tenants",
      "b6a8e8d4e9d9a4ea",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const raw = fs.readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(raw);
    expect(entry.connector).toBe("confluence");
    expect(entry.action).toBe("cql_search");
    expect(entry.kind).toBe("rate_limited");
  });

  it("hardship log goes project-local when cwd/.claude/ exists", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const client = makeClient({}, async () => jsonResponse({}, { status: 401 }));
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("get_page", { page_id: "1" });

    // Toolkit 3.0 uses tiered layout; scope = ctx.sdk.siteUrl hashed to 16-char hex.
    // sha16("https://example.atlassian.net") === "b6a8e8d4e9d9a4ea"
    const projectLog = path.join(
      tmpCwd,
      ".claude",
      "connectors",
      "confluence",
      "tenants",
      "b6a8e8d4e9d9a4ea",
      "hardships.jsonl",
    );
    const userLog = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "confluence",
      "tenants",
      "b6a8e8d4e9d9a4ea",
      "hardships.jsonl",
    );
    expect(fs.existsSync(projectLog)).toBe(true);
    expect(fs.existsSync(userLog)).toBe(false);
    const entry = JSON.parse(
      fs.readFileSync(projectLog, "utf-8").trim(),
    );
    expect(entry.kind).toBe("auth_error");
  });

  it("policy-denied calls do NOT produce hardship entries", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient({}, async () =>
      jsonResponse({ results: [] }),
    );
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("cql_search", { cql: "x" });

    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl.
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "confluence",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("validation errors produce hardship entries", async () => {
    const client = makeClient({}, async () =>
      jsonResponse({ results: [] }),
    );
    const c = buildConfluenceConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("get_page", { page_id: "not-numeric" });

    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl.
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "confluence",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.kind).toBe("validation");
  });
});

describe("--curate flag", () => {
  it("prints a JSON snapshot and exits 0", async () => {
    const c = buildConfluenceConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({}),
    });
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--curate"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join("").trim());
      expect(parsed.connector).toBe("confluence");
      expect(parsed).toHaveProperty("clusters");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
