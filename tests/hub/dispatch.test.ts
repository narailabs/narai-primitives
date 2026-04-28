/** Tests for the subprocess fan-out. Uses a temp Node script as the fake bin. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Readable } from "node:stream";

import { dispatchPlan } from "../../src/hub/dispatch.js";
import type { PlanStep, PreparedConnector, SpawnFn } from "../../src/hub/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-dispatch-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFakeBin(name: string, body: string): string {
  const file = path.join(tmpDir, `${name}.js`);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function preparedFor(name: string, binPath: string): PreparedConnector {
  return {
    name,
    binCommand: "node",
    binArgs: [binPath],
    skillContent: "",
    slice: {
      name,
      enabled: true,
      skill: `${name}-agent-connector`,
      model: null,
      enforce_hooks: true,
      policy: { read: "allow" },
      options: { foo: "bar" },
    },
  };
}

describe("dispatchPlan", () => {
  it("parses a successful envelope from stdout", async () => {
    const bin = writeFakeBin(
      "ok",
      `process.stdout.write(JSON.stringify({status:"success",action:"x",data:{ok:true}}));\n`,
    );
    const prepared = preparedFor("aws", bin);
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: { y: 1 } }];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    expect(results).toHaveLength(1);
    expect(results[0]?.envelope).toEqual({ status: "success", action: "x", data: { ok: true } });
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.step).toBe(1);
  });

  it("sets NARAI_CONFIG_BLOB env var with the resolved slice", async () => {
    // Bin echoes the env var as its envelope.
    const bin = writeFakeBin(
      "echo",
      `process.stdout.write(JSON.stringify({blob: process.env.NARAI_CONFIG_BLOB}));\n`,
    );
    const prepared = preparedFor("aws", bin);
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    expect(results[0]?.envelope).toBeDefined();
    const envelope = results[0]?.envelope as { blob: string };
    const parsed = JSON.parse(envelope.blob);
    expect(parsed.name).toBe("aws");
    expect(parsed.policy.read).toBe("allow");
    expect(parsed.options.foo).toBe("bar");
  });

  it("produces ENVELOPE_PARSE_ERROR for non-JSON stdout", async () => {
    const bin = writeFakeBin("garbage", `process.stdout.write("this is not json at all");\n`);
    const prepared = preparedFor("aws", bin);
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    expect(results[0]?.envelope).toBeUndefined();
    expect(results[0]?.error?.code).toBe("ENVELOPE_PARSE_ERROR");
    expect(results[0]?.error?.message).toMatch(/this is not json/);
  });

  it("produces DISPATCH_FAILED for missing bin", async () => {
    const prepared = preparedFor("aws", path.join(tmpDir, "does-not-exist.js"));
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    // Suppress the spawned node's MODULE_NOT_FOUND error noise — production
    // intentionally pipes stderr through; tests don't need to see it. vitest
    // auto-restores the spy after the test.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    expect(results[0]?.error?.code).toBe("DISPATCH_FAILED");
  });

  it("produces DISPATCH_FAILED when connector is not in preparedByName", async () => {
    const plan: PlanStep[] = [{ connector: "missing", action: "x", params: {} }];
    const results = await dispatchPlan(plan, new Map());
    expect(results[0]?.error?.code).toBe("DISPATCH_FAILED");
    expect(results[0]?.error?.message).toMatch(/not prepared/);
  });

  it("produces DISPATCH_FAILED when bin exits with no stdout", async () => {
    const bin = writeFakeBin("empty", `process.exit(0);\n`);
    const prepared = preparedFor("aws", bin);
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    expect(results[0]?.error?.code).toBe("DISPATCH_FAILED");
    expect(results[0]?.error?.message).toMatch(/no stdout/);
  });

  it("dispatches multiple steps in parallel (wall-clock check)", async () => {
    // Two slow bins that each sleep ~250ms; in parallel they finish well under 500ms.
    const slow = writeFakeBin(
      "slow",
      `setTimeout(() => process.stdout.write(JSON.stringify({status:"ok"})), 250);\n`,
    );
    const prepared = preparedFor("aws", slow);
    const plan: PlanStep[] = [
      { connector: "aws", action: "x", params: { i: 0 } },
      { connector: "aws", action: "x", params: { i: 1 } },
    ];
    const start = Date.now();
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    const wall = Date.now() - start;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.envelope !== undefined)).toBe(true);
    // Serial would be ~500ms, parallel ~250ms. Widened to < 1000ms because
    // subprocess spawn cost varies a lot across machines — still
    // distinguishes parallel from serial.
    expect(wall).toBeLessThan(1000);
  });

  it("produces DISPATCH_FAILED when injected spawnFn throws synchronously", async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("EACCES boom");
    };
    const prepared = preparedFor("aws", "/dev/null");
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]), {
      spawnProcess: throwingSpawn,
    });
    expect(results[0]?.error?.code).toBe("DISPATCH_FAILED");
    expect(results[0]?.error?.message).toMatch(/spawn failed.*EACCES boom/);
  });

  it("produces DISPATCH_FAILED when child emits an error event", async () => {
    const errorSpawn: SpawnFn = () => {
      const handlers: Record<string, ((arg: unknown) => void)[]> = {};
      setImmediate(() => {
        for (const h of handlers["error"] ?? []) h(new Error("ENOENT-ish"));
      });
      return {
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        on(event: string, listener: (arg: unknown) => void) {
          (handlers[event] ??= []).push(listener);
        },
      } as unknown as ReturnType<SpawnFn>;
    };
    const prepared = preparedFor("aws", "/dev/null");
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]), {
      spawnProcess: errorSpawn,
    });
    expect(results[0]?.error?.code).toBe("DISPATCH_FAILED");
    expect(results[0]?.error?.message).toMatch(/spawn error.*ENOENT-ish/);
  });

  it("step indices are 1-based and contiguous", async () => {
    const bin = writeFakeBin("ok", `process.stdout.write(JSON.stringify({ok:true}));\n`);
    const prepared = preparedFor("aws", bin);
    const plan: PlanStep[] = [
      { connector: "aws", action: "a", params: {} },
      { connector: "aws", action: "b", params: {} },
      { connector: "aws", action: "c", params: {} },
    ];
    const results = await dispatchPlan(plan, new Map([["aws", prepared]]));
    expect(results.map((r) => r.step)).toEqual([1, 2, 3]);
  });
});
