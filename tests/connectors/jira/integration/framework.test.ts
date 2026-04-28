/**
 * Framework integration tests — policy gate, hardship logger, --curate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJiraConnector } from "../../../../src/connectors/jira/index.js";
import {
  JiraClient,
  type JiraClientOptions,
} from "../../../../src/connectors/jira/lib/jira_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "jira-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
  delete process.env["JIRA_SITE_URL"];
  delete process.env["JIRA_EMAIL"];
  delete process.env["JIRA_API_TOKEN"];
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
  overrides: Partial<JiraClientOptions>,
  fetchMock: (url: string) => Promise<Response>,
): JiraClient {
  return new JiraClient({
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
  const dir = path.join(tmpCwd, ".jira-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("policy gate integration", () => {
  it("policy.read: escalate returns escalate envelope", async () => {
    writeRepoPolicy("policy:\n  read: escalate\n");
    const client = makeClient({}, async () =>
      jsonResponse({ total: 0, issues: [] }),
    );
    const c = buildJiraConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("jql_search", { jql: "x" });
    expect(r.status).toBe("escalate");
  });

  it("policy.read: denied skips handler", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient({}, async () =>
      jsonResponse({ total: 0, issues: [] }),
    );
    const c = buildJiraConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("get_project", { project_key: "FOO" });
    expect(r.status).toBe("denied");
  });

  it("approval_mode: confirm_each escalates reads", async () => {
    writeRepoPolicy("approval_mode: confirm_each\n");
    const client = makeClient({}, async () =>
      jsonResponse({ total: 0, issues: [] }),
    );
    const c = buildJiraConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("jql_search", { jql: "x" });
    expect(r.status).toBe("escalate");
  });
});

describe("hardship logging integration", () => {
  it("429 writes JSONL entry to user-global", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 429 }));
    const c = buildJiraConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("jql_search", { jql: "x" });

    // Toolkit 3.0 uses tiered layout; scope = ctx.sdk.siteUrl hashed to 16-char hex.
    // sha16("https://example.atlassian.net") === "b6a8e8d4e9d9a4ea"
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "jira",
      "tenants",
      "b6a8e8d4e9d9a4ea",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.connector).toBe("jira");
    expect(entry.kind).toBe("rate_limited");
  });

  it("routes to project-local when cwd/.claude exists", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const client = makeClient({}, async () => jsonResponse({}, { status: 401 }));
    const c = buildJiraConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("get_issue", { issue_key: "FOO-1" });
    // Toolkit 3.0 uses tiered layout; scope = ctx.sdk.siteUrl hashed to 16-char hex.
    // sha16("https://example.atlassian.net") === "b6a8e8d4e9d9a4ea"
    const projectLog = path.join(
      tmpCwd,
      ".claude",
      "connectors",
      "jira",
      "tenants",
      "b6a8e8d4e9d9a4ea",
      "hardships.jsonl",
    );
    expect(fs.existsSync(projectLog)).toBe(true);
  });
});

describe("--curate flag", () => {
  it("prints a JSON snapshot and exits 0", async () => {
    const c = buildJiraConnector({
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
      expect(parsed.connector).toBe("jira");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
