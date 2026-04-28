import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { UsageSummary } from "./types.js";

export interface CrossSessionOptions {
  dir: string;               // root .claude/connectors
  since: string;             // "7d" | "30d" | "all" | "Nd"
  connector?: string;        // filter to one connector
  now?: Date;                // for deterministic tests
}

export interface CrossSessionByConnector {
  sessions: number;
  calls: number;
  response_bytes: number;
  estimated_tokens: number;
}

export interface CrossSessionByDay {
  day: string;               // YYYY-MM-DD
  calls: number;
  response_bytes: number;
  estimated_tokens: number;
}

export interface CrossSessionReport {
  scope: {
    connector: string;       // "all" or a specific connector name
    since: string;           // ISO-8601 Z
    sessions_scanned: number;
  };
  totals: {
    calls: number;
    response_bytes: number;
    estimated_tokens: number;
    error_rate: number;
  };
  by_connector: Record<string, CrossSessionByConnector>;
  by_day: CrossSessionByDay[];
}

function parseSince(spec: string, now: Date): Date | null {
  if (spec === "all") return null;
  const m = spec.match(/^(\d+)d$/);
  if (!m) return null;
  const days = Number(m[1]);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function listSummaries(root: string, connector?: string): Array<{ connector: string; path: string }> {
  const result: Array<{ connector: string; path: string }> = [];
  let connectors: string[];
  try { connectors = readdirSync(root); } catch { return result; }
  for (const conn of connectors) {
    if (connector && conn !== connector) continue;
    const usageDir = join(root, conn, "usage");
    if (!existsSync(usageDir)) continue;
    let files: string[];
    try { files = readdirSync(usageDir); } catch { continue; }
    for (const f of files) {
      if (f.startsWith("summary-") && f.endsWith(".json")) {
        result.push({ connector: conn, path: join(usageDir, f) });
      }
    }
  }
  return result;
}

export async function aggregateCrossSession(
  opts: CrossSessionOptions,
): Promise<CrossSessionReport> {
  const now = opts.now ?? new Date();
  const since = parseSince(opts.since, now);
  const summaries = listSummaries(opts.dir, opts.connector);

  const byConnector: Record<string, CrossSessionByConnector & { errorCalls: number }> = {};
  const byDay = new Map<string, CrossSessionByDay>();
  let totalCalls = 0, totalBytes = 0, totalTokens = 0, totalErrors = 0;
  let scanned = 0;

  for (const { connector, path } of summaries) {
    let summary: UsageSummary;
    try {
      summary = JSON.parse(readFileSync(path, "utf-8")) as UsageSummary;
    } catch { continue; }

    // Use end time (or start time if end missing) as the session's effective time.
    const endTs = summary.end || summary.start;
    if (since && endTs && new Date(endTs) < since) continue;
    scanned += 1;

    const calls = summary.total_calls ?? 0;
    const bytes = summary.total_response_bytes ?? 0;
    const tokens = summary.total_estimated_tokens ?? 0;
    const errorCalls = Math.round((summary.error_rate ?? 0) * calls);

    totalCalls += calls;
    totalBytes += bytes;
    totalTokens += tokens;
    totalErrors += errorCalls;

    const slot = byConnector[connector] ??= {
      sessions: 0, calls: 0, response_bytes: 0, estimated_tokens: 0, errorCalls: 0,
    };
    slot.sessions += 1;
    slot.calls += calls;
    slot.response_bytes += bytes;
    slot.estimated_tokens += tokens;
    slot.errorCalls += errorCalls;

    if (endTs) {
      const day = endTs.slice(0, 10);
      const d = byDay.get(day) ?? { day, calls: 0, response_bytes: 0, estimated_tokens: 0 };
      d.calls += calls;
      d.response_bytes += bytes;
      d.estimated_tokens += tokens;
      byDay.set(day, d);
    }
  }

  const cleanByConnector: Record<string, CrossSessionByConnector> = {};
  for (const [k, v] of Object.entries(byConnector)) {
    cleanByConnector[k] = {
      sessions: v.sessions,
      calls: v.calls,
      response_bytes: v.response_bytes,
      estimated_tokens: v.estimated_tokens,
    };
  }

  return {
    scope: {
      connector: opts.connector ?? "all",
      since: since ? since.toISOString() : "all",
      sessions_scanned: scanned,
    },
    totals: {
      calls: totalCalls,
      response_bytes: totalBytes,
      estimated_tokens: totalTokens,
      error_rate: totalCalls > 0 ? totalErrors / totalCalls : 0,
    },
    by_connector: cleanByConnector,
    by_day: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export function renderCrossSessionMarkdown(r: CrossSessionReport): string {
  const connHeader = r.scope.connector === "all" ? "all connectors" : r.scope.connector;
  const sinceHeader = r.scope.since === "all" ? "all time" : `since ${r.scope.since}`;

  const connRows = Object.entries(r.by_connector)
    .sort(([, a], [, b]) => b.response_bytes - a.response_bytes)
    .map(([name, c]) =>
      `| ${name} | ${c.sessions} | ${c.calls.toLocaleString()} | ${c.response_bytes.toLocaleString()} | ${c.estimated_tokens.toLocaleString()} |`)
    .join("\n");

  const dayRows = r.by_day
    .map((d) => `| ${d.day} | ${d.calls.toLocaleString()} | ${d.response_bytes.toLocaleString()} | ${d.estimated_tokens.toLocaleString()} |`)
    .join("\n");

  return [
    `# Usage report — ${connHeader}, ${sinceHeader}`, ``,
    `Sessions scanned: ${r.scope.sessions_scanned}`, ``,
    `## Totals`,
    `- Calls: ${r.totals.calls.toLocaleString()}`,
    `- Response bytes: ${r.totals.response_bytes.toLocaleString()}`,
    `- Estimated tokens: ${r.totals.estimated_tokens.toLocaleString()}`,
    `- Error rate: ${(r.totals.error_rate * 100).toFixed(1)}%`,
    ``,
    `## By connector`, ``,
    `| connector | sessions | calls | bytes | est. tokens |`,
    `|---|---|---|---|---|`,
    connRows || "| _(none)_ |", ``,
    `## By day`, ``,
    `| day | calls | bytes | est. tokens |`,
    `|---|---|---|---|`,
    dayRows || "| _(none)_ |", ``,
  ].join("\n");
}
