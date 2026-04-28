/**
 * Framework integration tests — policy gate, hardship logger, --curate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAwsConnector } from "../../../../src/connectors/aws/index.js";
import {
  AwsClient,
  type AwsSdkFactories,
} from "../../../../src/connectors/aws/lib/aws_client.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aws-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "aws-cwd-"));
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

function makeClient(factories: AwsSdkFactories): AwsClient {
  return new AwsClient({
    region: "us-east-1",
    factories,
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    sleepImpl: async () => {},
  });
}

function writeRepoPolicy(yaml: string) {
  const dir = path.join(tmpCwd, ".aws-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml);
}

describe("policy gate integration", () => {
  it("policy.read: escalate returns escalate envelope", async () => {
    writeRepoPolicy("policy:\n  read: escalate\n");
    const client = makeClient({
      lambda: () => ({ send: async () => ({ Functions: [] }) }),
    });
    const c = buildAwsConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_functions", { region: "us-east-1" });
    expect(r.status).toBe("escalate");
  });

  it("policy.read: denied skips handler", async () => {
    writeRepoPolicy("policy:\n  read: denied\n");
    const client = makeClient({
      lambda: () => ({ send: async () => ({ Functions: [] }) }),
    });
    const c = buildAwsConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_functions", { region: "us-east-1" });
    expect(r.status).toBe("denied");
  });

  it("approval_mode: confirm_each escalates reads", async () => {
    writeRepoPolicy("approval_mode: confirm_each\n");
    const client = makeClient({
      lambda: () => ({ send: async () => ({ Functions: [] }) }),
    });
    const c = buildAwsConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_functions", { region: "us-east-1" });
    expect(r.status).toBe("escalate");
  });
});

describe("hardship logging integration", () => {
  it("SDK timeout writes hardship entry", async () => {
    const client = makeClient({
      lambda: () => ({
        send: () =>
          new Promise<Record<string, unknown>>(() => {
            /* never resolves */
          }),
      }),
    });
    // Speed up timeout path for the test.
    const client2 = new AwsClient({
      region: "us-east-1",
      factories: {
        lambda: () => ({
          send: () =>
            new Promise<Record<string, unknown>>(() => {
              /* never resolves */
            }),
        }),
      },
      connectTimeoutMs: 5,
      readTimeoutMs: 5,
      sleepImpl: async () => {},
    });
    const c = buildAwsConnector({
      sdk: async () => client2,
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_functions", { region: "us-east-1" });
    expect(r.status).toBe("error");
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (scope returns null → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "aws",
      "global",
      "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.connector).toBe("aws");
    expect(entry.kind).toBe("timeout");
  });

  it("validation errors produce hardship entries", async () => {
    const client = makeClient({});
    const c = buildAwsConnector({
      sdk: async () => client,
      credentials: async () => ({}),
    });
    await c.fetch("list_functions", { region: "Bad-Region" });
    // Toolkit 3.0 uses tiered layout: global/hardships.jsonl (validation errors → global tier).
    const logPath = path.join(
      tmpHome,
      ".claude",
      "connectors",
      "aws",
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
    const c = buildAwsConnector({
      sdk: async () => makeClient({}),
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
      expect(parsed.connector).toBe("aws");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
