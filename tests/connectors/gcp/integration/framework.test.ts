/**
 * Framework integration tests — policy gate, hardship logger, --curate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGcpConnector } from "../../../../src/connectors/gcp/index.js";
import {
  GcpClient,
  type GcpClientOptions,
} from "../../../../src/connectors/gcp/lib/gcp_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gcp-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gcp-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome !== undefined) process.env["HOME"] = origHome;
  else delete process.env["HOME"];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function makeClient(stdout: string): GcpClient {
  const runner = ((_file: string, _args: string[]) => stdout) as
    GcpClientOptions["runner"];
  return new GcpClient({
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    runner,
    sleepImpl: async () => {},
  });
}

function writeRepoPolicy(yaml: string) {
  const dir = path.join(tmpCwd, ".gcp-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("policy gate integration", () => {
  it("policy.read: escalate returns escalate envelope", async () => {
    writeRepoPolicy("policy:\n  read: escalate\n");
    const client = makeClient("[]");
    const c = buildGcpConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_services", { project_id: "acme-prod-123" });
    expect(r.status).toBe("escalate");
  });

  it("policy.read: denied skips handler", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient("[]");
    const c = buildGcpConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_topics", { project_id: "acme-prod-123" });
    expect(r.status).toBe("denied");
  });

  it("approval_mode: confirm_each escalates reads", async () => {
    writeRepoPolicy("approval_mode: confirm_each\n");
    const client = makeClient("[]");
    const c = buildGcpConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_services", { project_id: "acme-prod-123" });
    expect(r.status).toBe("escalate");
  });
});

describe("hardship logging integration", () => {
  it("validation errors produce hardship entries", async () => {
    const client = makeClient("[]");
    const c = buildGcpConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("list_services", { project_id: "BAD" });
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (validation errors → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "gcp",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.kind).toBe("validation");
  });

  it("filter injection attempt produces validation hardship", async () => {
    const client = makeClient("[]");
    const c = buildGcpConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: "severity=ERROR;rm -rf /",
    });
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (validation errors → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "gcp",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
  });
});

describe("--curate flag", () => {
  it("prints a JSON snapshot and exits 0", async () => {
    const c = buildGcpConnector({
      sdk: async () => makeClient("[]"),
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
      expect(parsed.connector).toBe("gcp");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
