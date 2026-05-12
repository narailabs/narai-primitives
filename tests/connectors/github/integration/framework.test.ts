/**
 * Framework integration tests — policy gate, hardship logger, --curate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGithubConnector } from "../../../../src/connectors/github/index.js";
import {
  GithubClient,
  type GithubClientOptions,
} from "../../../../src/connectors/github/lib/github_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gh-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
  delete process.env["GITHUB_TOKEN"];
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
  overrides: Partial<GithubClientOptions>,
  fetchMock: (url: string) => Promise<Response>,
): GithubClient {
  return new GithubClient({
    token: "ghp_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url) => fetchMock(String(url)),
    sleepImpl: async () => {},
    ...overrides,
  });
}

function writeRepoPolicy(yaml: string) {
  const dir = path.join(tmpCwd, ".github-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("policy gate integration", () => {
  it("policy.read: escalate returns escalate envelope", async () => {
    writeRepoPolicy("policy:\n  read: escalate\n");
    const client = makeClient({}, async () =>
      jsonResponse({ full_name: "a/b" }),
    );
    const c = buildGithubConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("repo_info", { owner: "a", repo: "b" });
    expect(r.status).toBe("escalate");
  });

  it("policy.read: denied skips handler", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient({}, async () =>
      jsonResponse({ full_name: "a/b" }),
    );
    const c = buildGithubConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("repo_info", { owner: "a", repo: "b" });
    expect(r.status).toBe("denied");
  });

  it("approval_mode: confirm_each escalates reads", async () => {
    writeRepoPolicy("approval_mode: confirm_each\n");
    const client = makeClient({}, async () =>
      jsonResponse({ full_name: "a/b" }),
    );
    const c = buildGithubConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("repo_info", { owner: "a", repo: "b" });
    expect(r.status).toBe("escalate");
  });
});

describe("hardship logging integration", () => {
  it("429 writes JSONL entry to user-global", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 429 }));
    const c = buildGithubConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("repo_info", { owner: "a", repo: "b" });

    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (scope returns null → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "github",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.connector).toBe("github");
    expect(entry.kind).toBe("rate_limited");
  });

  it("path traversal rejected + hardship logged", async () => {
    const client = makeClient({}, async () => jsonResponse({}));
    const c = buildGithubConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("get_file", {
      owner: "a",
      repo: "b",
      path: "../etc/passwd",
    });
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (validation errors → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "github",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.kind).toBe("validation");
  });
});

describe("policy defaults & floors", () => {
  it("rejects operator YAML setting policy.aspects.delete: success", async () => {
    writeRepoPolicy("policy:\n  aspects:\n    delete: success\n");
    const c = buildGithubConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "ghp_test" }),
    });
    // The toolkit loads policy eagerly on connector creation; the load error
    // surfaces as a CONFIG_ERROR envelope on the first fetch call.
    const result = await c.fetch("repo_info", { owner: "o", repo: "r" });
    expect(result.status).toBe("error");
    expect((result as { error_code?: string }).error_code).toBe("CONFIG_ERROR");
    expect((result as { message?: string }).message).toMatch(/aspects.delete/);
  });

  it("admin actions are denied under defaultPolicy (no operator config)", async () => {
    // No writeRepoPolicy call — falls through to the connector's defaultPolicy.
    const c = buildGithubConnector({
      sdk: async () =>
        makeClient({}, async () => jsonResponse({ sha: "x", merged: true })),
      credentials: async () => ({ token: "ghp_test" }),
    });
    const r = await c.fetch("merge_pull_request", {
      owner: "o",
      repo: "r",
      pull_number: 1,
      merge_method: "merge",
    });
    expect(r.status).toBe("denied");
    expect((r as { reason?: string }).reason).toMatch(/admin/);
  });

  it("write+delete aspect escalates by default (no operator config)", async () => {
    const c = buildGithubConnector({
      sdk: async () =>
        makeClient({}, async () =>
          jsonResponse({ number: 1, title: "t", state: "closed" }),
        ),
      credentials: async () => ({ token: "ghp_test" }),
    });
    const r = await c.fetch("close_pull_request", {
      owner: "o",
      repo: "r",
      pull_number: 1,
    });
    expect(r.status).toBe("escalate");
  });
});

describe("action surface — count + classifications", () => {
  it("exposes exactly 36 actions", () => {
    const c = buildGithubConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "ghp_test" }),
    });
    expect(c.validActions.size).toBe(36);
  });

  it("spot-checks classifications for representative actions", () => {
    const c = buildGithubConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "ghp_test" }),
    });
    expect(c.validActions.has("merge_pull_request")).toBe(true);
    expect(c.validActions.has("close_pull_request")).toBe(true);
    expect(c.validActions.has("close_issue")).toBe(true);
    expect(c.validActions.has("delete_issue_comment")).toBe(true);
    expect(c.validActions.has("delete_pr_review_comment")).toBe(true);
    expect(c.validActions.has("delete_release")).toBe(true);
    expect(c.validActions.has("delete_release_asset")).toBe(true);
  });

  it("merge_pull_request denies under default policy (no operator config)", async () => {
    const c = buildGithubConnector({
      sdk: async () =>
        makeClient({}, async () =>
          jsonResponse({ sha: "x", merged: true, message: "ok" }),
        ),
      credentials: async () => ({ token: "ghp_test" }),
    });
    const r = await c.fetch("merge_pull_request", {
      owner: "o",
      repo: "r",
      pull_number: 1,
      merge_method: "merge",
    });
    expect(r.status).toBe("denied");
  });

  it("merge_pull_request can be enabled by operator YAML", async () => {
    writeRepoPolicy("policy:\n  admin: escalate\n");
    const c = buildGithubConnector({
      sdk: async () =>
        makeClient({}, async () =>
          jsonResponse({ sha: "x", merged: true, message: "ok" }),
        ),
      credentials: async () => ({ token: "ghp_test" }),
    });
    const r = await c.fetch("merge_pull_request", {
      owner: "o",
      repo: "r",
      pull_number: 1,
      merge_method: "merge",
    });
    expect(r.status).toBe("escalate");
  });
});

describe("--curate flag", () => {
  it("prints a JSON snapshot and exits 0", async () => {
    const c = buildGithubConnector({
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
      expect(parsed.connector).toBe("github");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
