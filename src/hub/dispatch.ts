/** Subprocess fan-out — run plan steps in parallel, returning per-step
 *  envelopes or structured errors.
 *
 *  Memory & cancellation safeguards (added during the narai-primitives
 *  consolidation):
 *    - per-spawn timeout (default 60s; SIGTERM then SIGKILL after grace)
 *    - stdout buffer cap (default 50 MB; runaway connectors can't OOM the parent)
 *    - concurrency limit on plan dispatch (default 8; widely-fanned plans
 *      don't spawn 50+ children at once)
 *    - AbortSignal propagation: caller can cancel mid-`gather()`
 *    - parent-exit child cleanup: SIGTERM all in-flight children when the
 *      parent receives SIGINT/SIGTERM/exit
 *
 *  Every safeguard surfaces a structured error envelope on the affected step
 *  rather than throwing, matching the `DispatchResult.error` contract that
 *  callers like doc-wiki's `applyMermaid` already handle. */

import { spawn as nodeSpawn } from "node:child_process";

import type {
  DispatchResult,
  PlanStep,
  PreparedConnector,
  SpawnFn,
} from "./types.js";

const STDOUT_PREVIEW_CHARS = 200;

/** Default per-spawn timeout. Overridable per call via `dispatchPlan({ timeoutMs })`. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default stdout cap (50 MB). Overridable per call via `dispatchPlan({ maxStdoutBytes })`. */
const DEFAULT_MAX_STDOUT_BYTES = 50 * 1024 * 1024;
/** Default concurrent-spawn cap. Overridable per call via `dispatchPlan({ concurrency })`. */
const DEFAULT_CONCURRENCY = 8;
/** Grace period between SIGTERM and SIGKILL when killing a hung child. */
const SIGKILL_GRACE_MS = 2_000;

const defaultSpawn: SpawnFn = (cmd, args, opts) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  return nodeSpawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
};

export interface DispatchOptions {
  spawnProcess?: SpawnFn;
  /** Hard timeout per spawned connector (ms). Default 60_000. */
  timeoutMs?: number;
  /** Max stdout bytes the parent will accumulate per connector. Default 50 MB. */
  maxStdoutBytes?: number;
  /** Maximum number of concurrent connector subprocesses. Default 8. */
  concurrency?: number;
  /** AbortSignal that cancels in-flight spawns and skips remaining steps. */
  signal?: AbortSignal;
}

// ── Module-level child registry for parent-exit cleanup ───────────────
//
// Every running child registers itself here. When the parent process is
// asked to terminate, we SIGTERM all live children synchronously so they
// don't outlive us. Idempotent — exit handlers are wired once.

interface KillableChild {
  kill(signal?: NodeJS.Signals | number): boolean;
  killed?: boolean;
}
const liveChildren: Set<KillableChild> = new Set();
let exitHandlersWired = false;
function ensureExitHandlers(): void {
  if (exitHandlersWired) return;
  exitHandlersWired = true;
  const teardown = (): void => {
    for (const c of liveChildren) {
      try {
        if (!c.killed) c.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    liveChildren.clear();
  };
  process.on("exit", teardown);
  process.on("SIGINT", () => {
    teardown();
    // Re-raise so the user's terminal exits with the conventional code.
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    teardown();
    process.exit(143);
  });
}

// ── Public API ────────────────────────────────────────────────────────

/** Dispatch a validated plan in parallel (bounded by `concurrency`). Each step
 *  gets its own DispatchResult. `runStep` never rejects — every error path
 *  resolves to a structured result. */
export async function dispatchPlan(
  plan: readonly PlanStep[],
  preparedByName: ReadonlyMap<string, PreparedConnector>,
  opts: DispatchOptions = {},
): Promise<DispatchResult[]> {
  ensureExitHandlers();
  const spawnFn = opts.spawnProcess ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const signal = opts.signal;

  // Pre-allocate result slots so the order matches the input plan even when
  // steps complete out of order.
  const results: DispatchResult[] = new Array(plan.length);

  // Simple bounded-concurrency runner: index marches through `plan` while
  // up to `concurrency` workers pick the next index in turn.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < plan.length) {
      const idx = next++;
      const step = plan[idx]!;
      // Honor cancellation before starting any new step.
      if (signal?.aborted) {
        results[idx] = abortedResult(idx + 1, step);
        continue;
      }
      results[idx] = await runStep(
        idx + 1,
        step,
        preparedByName,
        spawnFn,
        timeoutMs,
        maxStdoutBytes,
        signal,
      );
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(concurrency, plan.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ── Step runner ───────────────────────────────────────────────────────

function abortedResult(stepIdx: number, step: PlanStep): DispatchResult {
  return {
    step: stepIdx,
    connector: step.connector,
    action: step.action,
    params: step.params,
    error: { code: "ABORTED", message: "dispatch aborted via AbortSignal" },
  };
}

function runStep(
  stepIdx: number,
  step: PlanStep,
  preparedByName: ReadonlyMap<string, PreparedConnector>,
  spawnFn: SpawnFn,
  timeoutMs: number,
  maxStdoutBytes: number,
  signal: AbortSignal | undefined,
): Promise<DispatchResult> {
  const prepared = preparedByName.get(step.connector);
  if (prepared === undefined) {
    return Promise.resolve({
      step: stepIdx,
      connector: step.connector,
      action: step.action,
      params: step.params,
      error: {
        code: "DISPATCH_FAILED",
        message: `connector '${step.connector}' not prepared`,
      },
    });
  }

  const cliArgs = [
    ...prepared.binArgs,
    "--action",
    step.action,
    "--params",
    JSON.stringify(step.params),
  ];
  const blob = JSON.stringify(prepared.slice);

  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(prepared.binCommand, cliArgs, {
        env: { NARAI_CONFIG_BLOB: blob },
      });
    } catch (err) {
      resolve({
        step: stepIdx,
        connector: step.connector,
        action: step.action,
        params: step.params,
        error: {
          code: "DISPATCH_FAILED",
          message: `spawn failed: ${(err as Error).message}`,
        },
      });
      return;
    }

    let stdoutBuf = "";
    let stdoutBytes = 0;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killGraceHandle: NodeJS.Timeout | undefined;
    const childLike: KillableChild = child as unknown as KillableChild;
    liveChildren.add(childLike);

    const cleanup = (): void => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (killGraceHandle !== undefined) clearTimeout(killGraceHandle);
      liveChildren.delete(childLike);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    };

    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    /** Kill the child gracefully, with SIGKILL fallback after a short grace. */
    const killChild = (): void => {
      try {
        if (!childLike.killed) childLike.kill("SIGTERM");
      } catch {
        // best-effort
      }
      killGraceHandle = setTimeout(() => {
        try {
          if (!childLike.killed) childLike.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }, SIGKILL_GRACE_MS);
    };

    // Timeout — finish with structured TIMEOUT error.
    timeoutHandle = setTimeout(() => {
      killChild();
      finish({
        step: stepIdx,
        connector: step.connector,
        action: step.action,
        params: step.params,
        error: {
          code: "TIMEOUT",
          message: `connector did not exit within ${timeoutMs}ms`,
        },
      });
    }, timeoutMs);

    // AbortSignal — finish with structured ABORTED error.
    const onAbort = (): void => {
      killChild();
      finish({
        step: stepIdx,
        connector: step.connector,
        action: step.action,
        params: step.params,
        error: { code: "ABORTED", message: "dispatch aborted via AbortSignal" },
      });
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text, "utf-8");
      if (stdoutBytes > maxStdoutBytes) {
        killChild();
        finish({
          step: stepIdx,
          connector: step.connector,
          action: step.action,
          params: step.params,
          error: {
            code: "STDOUT_CAP_EXCEEDED",
            message: `connector stdout exceeded ${maxStdoutBytes} bytes; aborted`,
          },
        });
        return;
      }
      stdoutBuf += text;
    });
    // Pass stderr through verbatim so callers see connector diagnostics.
    child.stderr.on("data", (chunk: Buffer | string) => {
      process.stderr.write(chunk);
    });
    child.on("error", (err: Error) => {
      finish({
        step: stepIdx,
        connector: step.connector,
        action: step.action,
        params: step.params,
        error: {
          code: "DISPATCH_FAILED",
          message: `spawn error: ${err.message}`,
        },
      });
    });
    child.on("exit", (code: number | null) => {
      const trimmed = stdoutBuf.trim();
      if (trimmed === "") {
        finish({
          step: stepIdx,
          connector: step.connector,
          action: step.action,
          params: step.params,
          error: {
            code: "DISPATCH_FAILED",
            message: `connector exited with code ${String(code)} and no stdout`,
          },
        });
        return;
      }
      try {
        const envelope = JSON.parse(trimmed);
        finish({
          step: stepIdx,
          connector: step.connector,
          action: step.action,
          params: step.params,
          envelope,
        });
      } catch {
        finish({
          step: stepIdx,
          connector: step.connector,
          action: step.action,
          params: step.params,
          error: {
            code: "ENVELOPE_PARSE_ERROR",
            message: `non-JSON stdout (preview): ${trimmed.slice(0, STDOUT_PREVIEW_CHARS)}`,
          },
        });
      }
    });
  });
}
