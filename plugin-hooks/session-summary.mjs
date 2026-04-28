#!/usr/bin/env node
// SessionEnd hook — summarize one session's usage.jsonl into a .json + .md pair.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function aggregate(connector, sessionId, records) {
  if (records.length === 0) {
    return {
      session_id: sessionId,
      connector,
      start: "",
      end: "",
      total_calls: 0,
      total_response_bytes: 0,
      total_estimated_tokens: 0,
      error_rate: 0,
      by_action: {},
      top_responses: [],
    };
  }
  const byAction = {};
  let totalBytes = 0, totalTokens = 0, errors = 0;
  let start = records[0].ts, end = records[0].ts;
  for (const r of records) {
    totalBytes += r.response_bytes;
    totalTokens += r.estimated_tokens;
    if (r.status !== "success") errors++;
    if (r.ts < start) start = r.ts;
    if (r.ts > end) end = r.ts;
    const s = byAction[r.action] ||= {
      calls: 0, response_bytes: 0, estimated_tokens: 0, ms_total: 0, ms_count: 0,
    };
    s.calls++;
    s.response_bytes += r.response_bytes;
    s.estimated_tokens += r.estimated_tokens;
    if (typeof r.execution_time_ms === "number") { s.ms_total += r.execution_time_ms; s.ms_count++; }
  }
  const by_action = {};
  for (const [k, s] of Object.entries(byAction)) {
    by_action[k] = {
      calls: s.calls,
      response_bytes: s.response_bytes,
      estimated_tokens: s.estimated_tokens,
      avg_ms: s.ms_count > 0 ? Math.round(s.ms_total / s.ms_count) : 0,
    };
  }
  const top_responses = [...records]
    .sort((a, b) => b.response_bytes - a.response_bytes)
    .slice(0, 3)
    .map((r) => ({ action: r.action, response_bytes: r.response_bytes }));
  return {
    session_id: sessionId,
    connector,
    start, end,
    total_calls: records.length,
    total_response_bytes: totalBytes,
    total_estimated_tokens: totalTokens,
    error_rate: errors / records.length,
    by_action,
    top_responses,
  };
}

function renderMd(s) {
  if (s.total_calls === 0) {
    return `# ${s.connector} usage — session ${s.session_id}\n\nNo calls recorded.\n`;
  }
  const successes = s.total_calls - Math.round(s.error_rate * s.total_calls);
  const errors = s.total_calls - successes;
  const rows = Object.entries(s.by_action)
    .sort(([, a], [, b]) => b.response_bytes - a.response_bytes)
    .map(([action, a]) =>
      `| ${action} | ${a.calls} | ${a.response_bytes.toLocaleString()} | ${a.estimated_tokens.toLocaleString()} | ${a.avg_ms} |`,
    ).join("\n");
  const top = s.top_responses.map((t, i) =>
    `${i + 1}. ${t.action} (${t.response_bytes.toLocaleString()} bytes)`).join("\n");
  return [
    `# ${s.connector} usage — session ${s.session_id}`, ``,
    `- Window: ${s.start} → ${s.end}`,
    `- Calls: ${s.total_calls} (${successes} success, ${errors} error — ${(s.error_rate * 100).toFixed(1)}%)`,
    `- Response bytes: ${s.total_response_bytes.toLocaleString()} | Estimated tokens: ${s.total_estimated_tokens.toLocaleString()}`,
    ``,
    `## By action`, ``,
    `| action | calls | bytes | est. tokens | avg ms |`,
    `|---|---|---|---|---|`,
    rows, ``,
    `## Top responses`, ``,
    top, ``,
  ].join("\n");
}

export function summarizeSession(baseDir, connector, sessionId) {
  const jsonl = join(baseDir, `${sessionId}.jsonl`);
  const summaryJson = join(baseDir, `summary-${sessionId}.json`);
  const summaryMd = join(baseDir, `summary-${sessionId}.md`);
  if (!existsSync(jsonl)) return;
  if (existsSync(summaryJson)) return;

  let raw;
  try { raw = readFileSync(jsonl, "utf-8"); } catch { return; }
  const records = raw.split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const summary = aggregate(connector, sessionId, records);
  try {
    writeFileSync(summaryJson, JSON.stringify(summary, null, 2), "utf-8");
    writeFileSync(summaryMd, renderMd(summary), "utf-8");
  } catch {
    // swallow
  }
}

function main() {
  const connector = process.env["USAGE_CONNECTOR_NAME"];
  if (!connector) return;

  let raw;
  try { raw = readFileSync(0, "utf-8"); } catch { return; }
  let sessionId = "unknown";
  try {
    const p = JSON.parse(raw || "{}");
    if (typeof p.session_id === "string") sessionId = p.session_id;
  } catch {}

  const baseDir =
    process.env["USAGE_STORAGE_DIR"] ||
    join(process.cwd(), ".claude", "connectors", connector, "usage");

  summarizeSession(baseDir, connector, sessionId);
}

// Only auto-run when executed directly (not when imported by stale-summarize.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch {}
  process.exit(0);
}
