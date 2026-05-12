/**
 * Framework integration tests — policy gate, hardship logger, --curate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGitlabConnector } from "../../../../src/connectors/gitlab/index.js";
import {
  GitlabClient,
  type GitlabClientOptions,
} from "../../../../src/connectors/gitlab/lib/gitlab_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gl-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gl-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
  delete process.env["GITLAB_TOKEN"];
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
  overrides: Partial<GitlabClientOptions>,
  fetchMock: (url: string) => Promise<Response>,
): GitlabClient {
  return new GitlabClient({
    token: "gl_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url) => fetchMock(String(url)),
    sleepImpl: async () => {},
    ...overrides,
  });
}

function writeRepoPolicy(yaml: string) {
  const dir = path.join(tmpCwd, ".gitlab-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("action surface — count + classifications", () => {
  it("validActions.size === 33", () => {
    const c = buildGitlabConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    expect(c.validActions.size).toBe(33);
  });

  it("spot-checks: merge_merge_request is in validActions", () => {
    const c = buildGitlabConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    expect(c.validActions.has("merge_merge_request")).toBe(true);
    expect(c.validActions.has("close_merge_request")).toBe(true);
    expect(c.validActions.has("delete_note")).toBe(true);
    expect(c.validActions.has("delete_release")).toBe(true);
    expect(c.validActions.has("delete_release_link")).toBe(true);
    expect(c.validActions.has("project_info")).toBe(true);
  });
});

describe("default-policy gate", () => {
  it("merge_merge_request returns denied under no operator config", async () => {
    // No writeRepoPolicy — falls through to the connector's defaultPolicy (admin: denied).
    const c = buildGitlabConnector({
      sdk: async () =>
        makeClient({}, async () => jsonResponse({ state: "merged", iid: 1 })),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    const r = await c.fetch("merge_merge_request", {
      namespace: "mygroup",
      project: "myrepo",
      mr_iid: 1,
    });
    expect(r.status).toBe("denied");
    expect((r as { reason?: string }).reason).toMatch(/admin/);
  });

  it("close_merge_request escalates by default (write+delete aspect)", async () => {
    const c = buildGitlabConnector({
      sdk: async () =>
        makeClient({}, async () =>
          jsonResponse({ iid: 1, title: "t", state: "closed" }),
        ),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    const r = await c.fetch("close_merge_request", {
      namespace: "mygroup",
      project: "myrepo",
      mr_iid: 1,
    });
    expect(r.status).toBe("escalate");
  });
});

describe("operator opt-in", () => {
  it("merge_merge_request returns escalate with policy.admin: escalate", async () => {
    writeRepoPolicy("policy:\n  admin: escalate\n");
    const c = buildGitlabConnector({
      sdk: async () =>
        makeClient({}, async () =>
          jsonResponse({ state: "merged", iid: 1, sha: "abc" }),
        ),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    const r = await c.fetch("merge_merge_request", {
      namespace: "mygroup",
      project: "myrepo",
      mr_iid: 1,
    });
    expect(r.status).toBe("escalate");
  });
});

describe("floor enforcement", () => {
  it("policy.aspects.delete: success produces CONFIG_ERROR at startup", async () => {
    writeRepoPolicy("policy:\n  aspects:\n    delete: success\n");
    const c = buildGitlabConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    const result = await c.fetch("project_info", {
      namespace: "mygroup",
      project: "myrepo",
    });
    expect(result.status).toBe("error");
    expect((result as { error_code?: string }).error_code).toBe("CONFIG_ERROR");
    expect((result as { message?: string }).message).toMatch(/aspects.delete/);
  });
});

describe("hardship logging integration", () => {
  it("429 writes JSONL entry to user-global", async () => {
    const client = makeClient({}, async () => jsonResponse({}, { status: 429 }));
    const c = buildGitlabConnector({
      sdk: async () => client,
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
    });
    await c.fetch("project_info", { namespace: "mygroup", project: "myrepo" });

    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (scope returns null → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "gitlab",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.connector).toBe("gitlab");
    expect(entry.kind).toBe("rate_limited");
  });
});

describe("--curate flag", () => {
  it("prints a JSON snapshot and exits 0", async () => {
    const c = buildGitlabConnector({
      sdk: async () => makeClient({}, async () => jsonResponse({})),
      credentials: async () => ({ token: "gl_test", host: "https://gitlab.com" }),
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
      expect(parsed.connector).toBe("gitlab");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
