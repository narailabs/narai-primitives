/** Tests for the memory & cancellation safeguards added to dispatchPlan
 *  during the narai-primitives consolidation: timeout, stdout cap,
 *  concurrency limit, AbortSignal. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchPlan } from "../../src/hub/dispatch.js";
import type { PlanStep, PreparedConnector } from "../../src/hub/types.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-safe-"));
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
      options: {},
    },
  };
}

describe("dispatchPlan safeguards", () => {
  // ── timeout ─────────────────────────────────────────────────────────

  it("times out a hung connector and emits a TIMEOUT error envelope", async () => {
    // Bin that sleeps forever and never writes stdout.
    const hung = writeFakeBin("hung", `setInterval(() => {}, 1000);\n`);
    const prepared = preparedFor("aws", hung);
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const start = Date.now();
    const results = await dispatchPlan(
      plan,
      new Map([["aws", prepared]]),
      { timeoutMs: 200 },
    );
    const elapsed = Date.now() - start;
    expect(results).toHaveLength(1);
    expect(results[0]!.error?.code).toBe("TIMEOUT");
    expect(results[0]!.envelope).toBeUndefined();
    // Should kill at ~timeoutMs, not hang indefinitely. Allow 3-second slack
    // for SIGTERM→SIGKILL grace + setTimeout drift in slow environments.
    expect(elapsed).toBeLessThan(3500);
  });

  // ── stdout cap ──────────────────────────────────────────────────────

  it("aborts a connector that exceeds maxStdoutBytes", async () => {
    // Bin that floods stdout.
    const flood = writeFakeBin(
      "flood",
      // 100KB chunk repeatedly; cap is 4KB so it fires immediately.
      `const chunk = "x".repeat(100_000);
       function loop() { process.stdout.write(chunk); setImmediate(loop); }
       loop();`,
    );
    const prepared = preparedFor("aws", flood);
    const plan: PlanStep[] = [{ connector: "aws", action: "x", params: {} }];
    const results = await dispatchPlan(
      plan,
      new Map([["aws", prepared]]),
      { maxStdoutBytes: 4096, timeoutMs: 5000 },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.error?.code).toBe("STDOUT_CAP_EXCEEDED");
    expect(results[0]!.envelope).toBeUndefined();
  });

  // ── AbortSignal ─────────────────────────────────────────────────────

  it("cancels in-flight spawns when the AbortSignal fires", async () => {
    const slow = writeFakeBin(
      "slow",
      `setTimeout(() => process.stdout.write(JSON.stringify({status:"ok"})), 1000);\n`,
    );
    const prepared = preparedFor("aws", slow);
    const plan: PlanStep[] = [
      { connector: "aws", action: "x", params: { i: 0 } },
      { connector: "aws", action: "x", params: { i: 1 } },
    ];
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const results = await dispatchPlan(
      plan,
      new Map([["aws", prepared]]),
      { signal: ctrl.signal, timeoutMs: 5000 },
    );
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.error?.code).toBe("ABORTED");
    }
  });

  it("skips remaining steps when AbortSignal aborts before they start (concurrency=1)", async () => {
    const slow = writeFakeBin(
      "slow",
      `setTimeout(() => process.stdout.write(JSON.stringify({status:"ok"})), 50);\n`,
    );
    const prepared = preparedFor("aws", slow);
    const plan: PlanStep[] = [
      { connector: "aws", action: "x", params: { i: 0 } },
      { connector: "aws", action: "x", params: { i: 1 } },
      { connector: "aws", action: "x", params: { i: 2 } },
    ];
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const results = await dispatchPlan(
      plan,
      new Map([["aws", prepared]]),
      { signal: ctrl.signal, concurrency: 1, timeoutMs: 5000 },
    );
    // First step is in-flight when abort fires → ABORTED.
    // Subsequent steps haven't started → also ABORTED (skipped).
    const aborted = results.filter((r) => r.error?.code === "ABORTED");
    expect(aborted.length).toBeGreaterThan(0);
  });

  // ── concurrency limit ──────────────────────────────────────────────

  it("respects the concurrency limit (serial when concurrency=1)", async () => {
    const slow = writeFakeBin(
      "slow",
      `setTimeout(() => process.stdout.write(JSON.stringify({status:"ok"})), 200);\n`,
    );
    const prepared = preparedFor("aws", slow);
    const plan: PlanStep[] = [0, 1, 2].map((i) => ({
      connector: "aws",
      action: "x",
      params: { i },
    }));
    const start = Date.now();
    const results = await dispatchPlan(
      plan,
      new Map([["aws", prepared]]),
      { concurrency: 1, timeoutMs: 5000 },
    );
    const elapsed = Date.now() - start;
    expect(results).toHaveLength(3);
    // Serial execution ⇒ ~600ms minimum (3 × 200ms). Allow generous slack.
    expect(elapsed).toBeGreaterThan(550);
  });

  it("dispatches in parallel up to the concurrency limit", async () => {
    const slow = writeFakeBin(
      "slow",
      `setTimeout(() => process.stdout.write(JSON.stringify({status:"ok"})), 200);\n`,
    );
    const prepared = preparedFor("aws", slow);
    const plan: PlanStep[] = [0, 1, 2, 3].map((i) => ({
      connector: "aws",
      action: "x",
      params: { i },
    }));
    const start = Date.now();
    const results = await dispatchPlan(
      plan,
      new Map([["aws", prepared]]),
      { concurrency: 4, timeoutMs: 5000 },
    );
    const elapsed = Date.now() - start;
    expect(results).toHaveLength(4);
    // Fully parallel ⇒ ~200ms. Generous bound for sandbox timing variance.
    expect(elapsed).toBeLessThan(700);
  });
});
