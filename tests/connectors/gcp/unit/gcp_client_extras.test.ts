/**
 * Coverage extras for gcp_client.ts — targets every public method's happy
 * and error paths, the _throttle sliding-window, the _run command guards
 * (FORBIDDEN_BINARY, FORBIDDEN_COMMAND, UNSAFE_ARG), runner-error
 * classification (TIMEOUT vs EXEC_ERROR; retriable vs not), JSON-parse
 * branches, the stripSqlStringLiterals literal handler (single, double,
 * backtick, SQL `''` escapes, backslash escapes), and detectGcloudAvailable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GcpClient,
  type GcpClientOptions,
  detectGcloudAvailable,
} from "../../../../src/connectors/gcp/lib/gcp_client.js";

type RunnerCall = { file: string; args: string[] };

function makeClient(
  stdout: string | ((call: RunnerCall) => string),
  overrides: Partial<GcpClientOptions> = {},
): { client: GcpClient; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner = ((file: string, args: string[]) => {
    const call: RunnerCall = { file, args };
    calls.push(call);
    return typeof stdout === "function" ? stdout(call) : stdout;
  }) as GcpClientOptions["runner"];
  const client = new GcpClient({
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    runner,
    sleepImpl: async () => {},
    ...overrides,
  });
  return { client, calls };
}

function makeThrowingClient(
  err: unknown,
  overrides: Partial<GcpClientOptions> = {},
): GcpClient {
  const runner = (() => {
    throw err;
  }) as GcpClientOptions["runner"];
  return new GcpClient({
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    runner,
    sleepImpl: async () => {},
    ...overrides,
  });
}

describe("GcpClient — listServices", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns INVALID_PROJECT for too-short project IDs", async () => {
    const { client } = makeClient("[]");
    const r = await client.listServices("ab");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("returns INVALID_PROJECT for project IDs with capitals", async () => {
    const { client } = makeClient("[]");
    const r = await client.listServices("MyProject");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("returns INVALID_PROJECT for project IDs starting with a digit", async () => {
    const { client } = makeClient("[]");
    const r = await client.listServices("1abcdef");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("returns PARSE_ERROR when stdout is not valid JSON", async () => {
    const { client } = makeClient("not-json{");
    const r = await client.listServices("acme-prod-123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("returns PARSE_ERROR when stdout is JSON but not an array", async () => {
    const { client } = makeClient('{"foo": "bar"}');
    const r = await client.listServices("acme-prod-123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("treats empty / whitespace-only stdout as empty array", async () => {
    const { client } = makeClient("   \n  ");
    const r = await client.listServices("acme-prod-123");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it("propagates runner exec errors as EXEC_ERROR", async () => {
    const client = makeThrowingClient(new Error("boom"));
    const r = await client.listServices("acme-prod-123");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EXEC_ERROR");
      expect(r.retriable).toBe(false);
      expect(r.message).toContain("boom");
    }
  });
});

describe("GcpClient — describeSqlInstance", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns INVALID_PROJECT for malformed project_id", async () => {
    const { client } = makeClient("{}");
    const r = await client.describeSqlInstance("Bad-PROJ", "main-pg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("returns INVALID_INSTANCE for instance_id with disallowed chars", async () => {
    const { client } = makeClient("{}");
    const r = await client.describeSqlInstance("acme-prod-123", "bad name!");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_INSTANCE");
  });

  it("returns INVALID_INSTANCE for empty instance_id", async () => {
    const { client } = makeClient("{}");
    const r = await client.describeSqlInstance("acme-prod-123", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_INSTANCE");
  });

  it("returns PARSE_ERROR when stdout is JSON null", async () => {
    const { client } = makeClient("null");
    const r = await client.describeSqlInstance("acme-prod-123", "pg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("returns PARSE_ERROR when stdout is a JSON array (not object)", async () => {
    const { client } = makeClient("[]");
    const r = await client.describeSqlInstance("acme-prod-123", "pg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("returns PARSE_ERROR when stdout is unparseable JSON", async () => {
    const { client } = makeClient("{not valid");
    const r = await client.describeSqlInstance("acme-prod-123", "pg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("returns success on a well-formed object", async () => {
    const { client } = makeClient(
      JSON.stringify({ databaseVersion: "POSTGRES_15", state: "RUNNABLE" }),
    );
    const r = await client.describeSqlInstance("acme-prod-123", "pg-main");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.databaseVersion).toBe("POSTGRES_15");
  });

  it("propagates runner timeout errors as TIMEOUT (retriable)", async () => {
    const client = makeThrowingClient(new Error("Command timeout exceeded"));
    const r = await client.describeSqlInstance("acme-prod-123", "pg");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TIMEOUT");
      expect(r.retriable).toBe(true);
    }
  });
});

describe("GcpClient — listPubsubTopics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an invalid project ID (too long / trailing hyphen)", async () => {
    const { client } = makeClient("[]");
    const r = await client.listPubsubTopics("a-trailing-hyphen-");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("invokes gcloud pubsub topics list with --format=json", async () => {
    const { client, calls } = makeClient(
      '[{"name": "projects/acme-prod-123/topics/orders"}]',
    );
    const r = await client.listPubsubTopics("acme-prod-123");
    expect(r.ok).toBe(true);
    expect(calls[0]?.file).toBe("gcloud");
    expect(calls[0]?.args).toEqual([
      "pubsub",
      "topics",
      "list",
      "--project",
      "acme-prod-123",
      "--format=json",
    ]);
    if (r.ok) expect(r.data).toHaveLength(1);
  });

  it("returns PARSE_ERROR for non-array stdout", async () => {
    const { client } = makeClient('{"results": []}');
    const r = await client.listPubsubTopics("acme-prod-123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("propagates runner non-Error throwables as EXEC_ERROR", async () => {
    const client = makeThrowingClient("raw string");
    const r = await client.listPubsubTopics("acme-prod-123");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EXEC_ERROR");
      expect(r.message).toBe("raw string");
    }
  });
});

describe("GcpClient — queryLogs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects invalid project ID", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs("BAD", "severity=ERROR", 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("rejects filter with semicolon", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      "severity=ERROR; rm -rf /",
      1,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("rejects filter with single-quote", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs("acme-prod-123", "msg='bad'", 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("rejects filter with double-quote", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs("acme-prod-123", 'msg="bad"', 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("rejects filter with newline", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs("acme-prod-123", "a\nb", 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("rejects hours <= 0", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs("acme-prod-123", "severity=ERROR", 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INVALID_FILTER");
      expect(r.message).toMatch(/hours/);
    }
  });

  it("rejects hours > 168", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs("acme-prod-123", "severity=ERROR", 200, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("rejects non-finite hours", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      "severity=ERROR",
      Number.NaN,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("rejects Infinity hours", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      "severity=ERROR",
      Number.POSITIVE_INFINITY,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });

  it("clamps maxResults to at least 1", async () => {
    const { client, calls } = makeClient("[]");
    await client.queryLogs("acme-prod-123", "severity=ERROR", 1, 0);
    const limitIdx = calls[0]?.args.indexOf("--limit");
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.args[(limitIdx ?? -1) + 1]).toBe("1");
  });

  it("clamps maxResults to at most 1000", async () => {
    const { client, calls } = makeClient("[]");
    await client.queryLogs("acme-prod-123", "severity=ERROR", 1, 9999);
    const limitIdx = calls[0]?.args.indexOf("--limit");
    expect(calls[0]?.args[(limitIdx ?? -1) + 1]).toBe("1000");
  });

  it("truncates fractional hours", async () => {
    const { client, calls } = makeClient("[]");
    await client.queryLogs("acme-prod-123", "severity=ERROR", 24.7, 5);
    const idx = calls[0]?.args.indexOf("--freshness");
    expect(calls[0]?.args[(idx ?? -1) + 1]).toBe("24h");
  });

  it("returns PARSE_ERROR when stdout is not an array", async () => {
    const { client } = makeClient("{}");
    const r = await client.queryLogs("acme-prod-123", "severity=ERROR", 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("returns success with parsed log entries", async () => {
    const { client } = makeClient(
      '[{"timestamp": "2024-01-01T00:00:00Z", "severity": "ERROR", "textPayload": "boom"}]',
    );
    const r = await client.queryLogs(
      "acme-prod-123",
      "severity=ERROR",
      1,
      10,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data[0]?.severity).toBe("ERROR");
  });
});

describe("GcpClient — bqQuery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects invalid project ID", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery("BAD", "SELECT 1", 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
  });

  it("rejects non-SELECT (UPDATE)", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "UPDATE t SET x=1",
      10,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRITE_FORBIDDEN");
  });

  it("accepts SELECT regardless of leading whitespace and case", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery("acme-prod-123", "  select 1", 10);
    expect(r.ok).toBe(true);
  });

  it("rejects multi-statement scripts split by semicolons", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 1; SELECT 2",
      10,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRITE_FORBIDDEN");
  });

  it("permits semicolons inside backtick identifiers", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT * FROM `weird;name`",
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("permits semicolons inside double-quoted strings", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      'SELECT "a;b" AS v',
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("permits doubled-quote SQL escape inside string literal", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 'O''Hare;LAX' AS v",
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("permits backslash-escaped quote inside string literal", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 'foo\\';still in string' AS v",
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("clamps maxRows to at least 1", async () => {
    const { client, calls } = makeClient("[]");
    await client.bqQuery("acme-prod-123", "SELECT 1", 0);
    const arg = calls[0]?.args.find((a) => a.startsWith("--max_rows="));
    expect(arg).toBe("--max_rows=1");
  });

  it("truncates fractional maxRows", async () => {
    const { client, calls } = makeClient("[]");
    await client.bqQuery("acme-prod-123", "SELECT 1", 7.9);
    const arg = calls[0]?.args.find((a) => a.startsWith("--max_rows="));
    expect(arg).toBe("--max_rows=7");
  });

  it("returns rows + row_count on success", async () => {
    const { client } = makeClient('[{"x": 1}, {"x": 2}]');
    const r = await client.bqQuery("acme-prod-123", "SELECT x FROM t", 10);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.row_count).toBe(2);
      expect(r.data.rows).toHaveLength(2);
    }
  });

  it("returns PARSE_ERROR when bq stdout is not an array", async () => {
    const { client } = makeClient('{"err": "x"}');
    const r = await client.bqQuery("acme-prod-123", "SELECT 1", 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PARSE_ERROR");
  });

  it("propagates timeout from runner with retriable=true", async () => {
    const client = makeThrowingClient(new Error("ECONNRESET on socket"));
    const r = await client.bqQuery("acme-prod-123", "SELECT 1", 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EXEC_ERROR");
      expect(r.retriable).toBe(true);
    }
  });
});

describe("GcpClient — _run() guards (accessed via public methods + direct probing)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns FORBIDDEN_BINARY when an unknown binary is passed to _run", () => {
    const { client } = makeClient("");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("rm", "-rf /", []);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "FORBIDDEN_BINARY" }),
    );
  });

  it("returns FORBIDDEN_COMMAND for non-whitelisted gcloud subcommand", () => {
    const { client } = makeClient("");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("gcloud", "compute instances list", []);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "FORBIDDEN_COMMAND" }),
    );
  });

  it("returns UNSAFE_ARG when an arg contains shell metacharacters", () => {
    const { client } = makeClient("");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("gcloud", "services list", ["--project", "ok; rm -rf /"]);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "UNSAFE_ARG" }),
    );
  });

  it("returns UNSAFE_ARG for backtick metacharacter", () => {
    const { client } = makeClient("");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("gcloud", "services list", ["--project", "p`whoami`"]);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "UNSAFE_ARG" }),
    );
  });

  it("returns UNSAFE_ARG for $ metacharacter", () => {
    const { client } = makeClient("");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("gcloud", "services list", ["--project", "$VAR"]);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "UNSAFE_ARG" }),
    );
  });

  it("permits unsafe characters in the SQL body of bq query (last arg)", () => {
    const { client } = makeClient("[]");
    const result = (
      client as unknown as {
        _run: (
          b: string,
          s: string,
          a: string[],
        ) => { ok: boolean; data?: string; code?: string };
      }
    )._run("bq", "query", [
      "--project_id=acme-prod-123",
      "--use_legacy_sql=false",
      "--max_rows=1",
      "--format=json",
      "--quiet",
      "SELECT 'a;b'",
    ]);
    expect(result.ok).toBe(true);
  });

  it("still flags unsafe metachars in non-final bq query args", () => {
    const { client } = makeClient("[]");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("bq", "query", [
      "--project_id=acme;rm",
      "--max_rows=1",
      "SELECT 1",
    ]);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "UNSAFE_ARG" }),
    );
  });
});

describe("GcpClient — _throttle()", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not sleep when under the rate limit", async () => {
    const sleeps: number[] = [];
    const { client } = makeClient("[]", {
      rateLimitPerMin: 5,
      sleepImpl: async (ms) => void sleeps.push(ms),
    });
    await client.listServices("acme-prod-123");
    await client.listServices("acme-prod-123");
    expect(sleeps).toEqual([]);
  });

  it("sleeps when in-window count reaches the limit", async () => {
    const sleeps: number[] = [];
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { client } = makeClient("[]", {
        rateLimitPerMin: 2,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          // Advance the mocked clock past the cutoff so the next iteration
          // can drop the oldest timestamp and proceed.
          now += ms;
        },
      });
      await client.listServices("acme-prod-123");
      await client.listServices("acme-prod-123");
      await client.listServices("acme-prod-123");
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
      expect(sleeps[0]).toBeGreaterThan(0);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("does not sleep when the oldest timestamp is already > 60s old", async () => {
    const sleeps: number[] = [];
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { client } = makeClient("[]", {
        rateLimitPerMin: 1,
        sleepImpl: async (ms) => void sleeps.push(ms),
      });
      await client.listServices("acme-prod-123"); // record t=1_000_000
      now += 70_000; // jump > 60s
      await client.listServices("acme-prod-123"); // first call's timestamp is filtered
      expect(sleeps).toEqual([]);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("stripSqlStringLiterals — through bqQuery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips a backtick-quoted identifier with internal backslash escape", async () => {
    // The backslash branch (line 438-441) consumes the next char inside a
    // backtick-quoted run.
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT * FROM `weird\\`name`",
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("handles unterminated single-quoted literal (input falls off end)", async () => {
    // Unterminated literal exercises the `i < sql.length` outer loop exit
    // inside the inner while.
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 'unclosed",
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("handles a backslash at the very end of a string literal (no next char)", async () => {
    const { client } = makeClient("[]");
    // A trailing backslash inside an unterminated literal — the i+1 < length
    // guard is exercised.
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 'oops\\",
      10,
    );
    expect(r.ok).toBe(true);
  });

  it("handles consecutive empty doubled-quote escapes", async () => {
    const { client } = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT '''' AS empty",
      10,
    );
    expect(r.ok).toBe(true);
  });
});

describe("detectGcloudAvailable", () => {
  it("returns true when the runner succeeds", () => {
    const ok = detectGcloudAvailable(((file: string) => {
      // Should be invoked with 'gcloud --version'
      expect(file).toBe("gcloud");
      return "Google Cloud SDK 470.0.0\n";
    }) as Parameters<typeof detectGcloudAvailable>[0]);
    expect(ok).toBe(true);
  });

  it("returns false when the runner throws", () => {
    const ok = detectGcloudAvailable((() => {
      throw new Error("ENOENT");
    }) as Parameters<typeof detectGcloudAvailable>[0]);
    expect(ok).toBe(false);
  });
});

describe("GcpClient — constructor defaults", () => {
  it("uses default rate limit, timeouts, and a no-op sleep when nothing is passed", () => {
    // Just construct it and confirm getters work; no public assertion of the
    // numeric defaults exists, so we exercise the OR-fallback branches by
    // omitting every option.
    const c = new GcpClient();
    expect(c.defaultProjectId).toBeNull();
    expect(c.defaultRegion).toBeNull();
  });
});
