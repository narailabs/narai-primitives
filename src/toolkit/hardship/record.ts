/**
 * Hardship logger. Append-only JSONL capture of agent-observed friction.
 *
 * Storage layering (3.0, tiered):
 *   project-tenant: <cwd>/.claude/connectors/<name>/tenants/<hash>/hardships.jsonl
 *   project-global: <cwd>/.claude/connectors/<name>/global/hardships.jsonl
 *   user-tenant:    <home>/.claude/connectors/<name>/tenants/<hash>/hardships.jsonl
 *   user-global:    <home>/.claude/connectors/<name>/global/hardships.jsonl
 *
 * Write goes to the most-specific tier available. If cwd/.claude/ exists,
 * project-* tiers are eligible; otherwise user-* tiers only.
 *
 * Non-failing: disk errors are swallowed. Hardship MUST NEVER crash the
 * caller — that would turn a friction observation into a full outage.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveTierPaths } from "./scope.js";

/** A single friction observation. `ts` / `connector` / `session_id` are stamped by the writer. */
export interface HardshipEntry {
  ts: string;
  connector: string;
  action: string;
  /** Coarse category: "rate_limit" | "auth" | "not_found" | "timeout" | "validation" | "schema" | ... */
  kind: string;
  /** Human-readable description of what happened. */
  context: string;
  /** Tenant scope key (e.g. base URL). null = connector-wide, not tenant-specific. */
  scope: string | null;
  /** Optional — what (if anything) resolved it or made it tolerable. */
  resolution?: string;
  /** Optional session id correlating with audit trail. */
  session_id?: string;
}

export type HardshipInput = Omit<HardshipEntry, "ts" | "connector" | "session_id" | "scope"> & {
  scope?: string | null;
};

export interface HardshipWriterOptions {
  connector: string;
  enabled?: boolean;
  sessionId?: string;
  /** Override cwd (tests). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override home (tests). Defaults to `process.env["HOME"] ?? "/"`. */
  home?: string;
  /** Force a specific path (tests, or operator override). Bypasses discovery. */
  explicitPath?: string;
}

export interface ResolveHardshipPathOptions {
  connector: string;
  scope: string | null;
  cwd?: string;
  home?: string;
}

/** Compute where a hardship entry will be written given connector + scope + env. */
export function resolveHardshipPath(opts: ResolveHardshipPathOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? process.env["HOME"] ?? "/";
  const tiers = resolveTierPaths({
    connector: opts.connector,
    scope: opts.scope,
    cwd,
    home,
  });
  const hasProject = fs.existsSync(path.join(cwd, ".claude"));
  for (const t of tiers) {
    if (!hasProject && t.name.startsWith("project-")) continue;
    return path.join(t.dir, "hardships.jsonl");
  }
  // Unreachable: tiers always contains a user-global entry.
  return path.join(tiers[tiers.length - 1]!.dir, "hardships.jsonl");
}

export interface HardshipRecorder {
  (entry: HardshipInput): void;
}

export function createHardshipRecorder(
  opts: HardshipWriterOptions,
): HardshipRecorder {
  const connector = opts.connector;

  return (input: HardshipInput): void => {
    if (opts.enabled === false) return;
    const scope = input.scope ?? null;
    const dest =
      opts.explicitPath ??
      resolveHardshipPath({
        connector,
        scope,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const entry: HardshipEntry = {
        ts: new Date().toISOString(),
        connector,
        action: input.action,
        kind: input.kind,
        context: input.context,
        scope,
        ...(input.resolution !== undefined
          ? { resolution: input.resolution }
          : {}),
        ...(opts.sessionId !== undefined
          ? { session_id: opts.sessionId }
          : {}),
      };
      fs.appendFileSync(dest, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // swallow — never raise into caller
    }
  };
}
