/**
 * Framework integration tests — policy gate, hardship logger, --curate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildNotionConnector } from "../../../../src/connectors/notion/index.js";
import {
  NotionClient,
  type NotionClientOptions,
} from "../../../../src/connectors/notion/lib/notion_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "notion-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "notion-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
  delete process.env["NOTION_TOKEN"];
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome !== undefined) process.env["HOME"] = origHome;
  else delete process.env["HOME"];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  overrides: Partial<NotionClientOptions>,
  fetchMock: (url: string) => Promise<Response>,
): NotionClient {
  return new NotionClient({
    token: "secret_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url) => fetchMock(String(url)),
    sleepImpl: async () => {},
    ...overrides,
  });
}

function writeRepoPolicy(yaml: string) {
  const dir = path.join(tmpCwd, ".notion-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("policy gate integration", () => {
  it("policy.read: escalate returns escalate envelope", async () => {
    writeRepoPolicy("policy:\n  read: escalate\n");
    const client = makeClient({}, async () => jsonResponse({ results: [] }));
    const c = buildNotionConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("search", { query: "x" });
    expect(r.status).toBe("escalate");
  });

  it("policy.read: denied skips handler", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient({}, async () => jsonResponse({ results: [] }));
    const c = buildNotionConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch(
      "get_database",
      { database_id: "a1b2c3d4e5f6789012345678901234ab" },
    );
    expect(r.status).toBe("denied");
  });

  it("approval_mode: confirm_each escalates reads", async () => {
    writeRepoPolicy("approval_mode: confirm_each\n");
    const client = makeClient({}, async () => jsonResponse({ results: [] }));
    const c = buildNotionConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("search", { query: "x" });
    expect(r.status).toBe("escalate");
  });
});

describe("hardship logging integration", () => {
  it("429 writes JSONL entry to user-global", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 429 }));
    const c = buildNotionConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("search", { query: "x" });

    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (scope returns null → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "notion",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.connector).toBe("notion");
    expect(entry.kind).toBe("rate_limited");
  });

  it("routes to project-local when cwd/.claude exists", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const client = makeClient({}, async () => jsonResponse({}, { status: 401 }));
    const c = buildNotionConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch(
      "get_page",
      { page_id: "a1b2c3d4e5f6789012345678901234ab" },
    );
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (scope returns null → global tier).
    const projectLog = path.join(
      tmpCwd,
      ".claude",
      "connectors",
      "notion",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(projectLog)).toBe(true);
  });

  it("validation errors produce hardship entries", async () => {
    const client = makeClient({}, async () => jsonResponse({ results: [] }));
    const c = buildNotionConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("get_page", { page_id: "not-a-uuid" });
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (validation errors → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "notion",
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
    const c = buildNotionConnector({
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
      expect(parsed.connector).toBe("notion");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
