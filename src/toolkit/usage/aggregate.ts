import type {
  UsageRecord,
  UsageSummary,
  UsageActionBreakdown,
  UsageTopResponse,
} from "./types.js";

export function aggregateRecords(
  sessionId: string,
  connector: string,
  records: UsageRecord[],
): UsageSummary {
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

  const byAction: Record<
    string,
    {
      calls: number;
      response_bytes: number;
      estimated_tokens: number;
      ms_total: number;
      ms_count: number;
    }
  > = {};

  let totalBytes = 0;
  let totalTokens = 0;
  let errors = 0;
  let start = records[0].ts;
  let end = records[0].ts;

  for (const rec of records) {
    totalBytes += rec.response_bytes;
    totalTokens += rec.estimated_tokens;
    if (rec.status !== "success") errors += 1;
    if (rec.ts < start) start = rec.ts;
    if (rec.ts > end) end = rec.ts;

    const slot =
      byAction[rec.action] ??
      (byAction[rec.action] = {
        calls: 0,
        response_bytes: 0,
        estimated_tokens: 0,
        ms_total: 0,
        ms_count: 0,
      });
    slot.calls += 1;
    slot.response_bytes += rec.response_bytes;
    slot.estimated_tokens += rec.estimated_tokens;
    if (typeof rec.execution_time_ms === "number") {
      slot.ms_total += rec.execution_time_ms;
      slot.ms_count += 1;
    }
  }

  const by_action: Record<string, UsageActionBreakdown> = {};
  for (const [action, s] of Object.entries(byAction)) {
    by_action[action] = {
      calls: s.calls,
      response_bytes: s.response_bytes,
      estimated_tokens: s.estimated_tokens,
      avg_ms: s.ms_count > 0 ? Math.round(s.ms_total / s.ms_count) : 0,
    };
  }

  // ⚡ Bolt: Top-K Extraction O(N) Optimization
  // Replaced [...records].sort().slice(0, 3) which has O(N log N) time complexity
  // and blocks the event loop on large data sets, with an O(N) manual loop.
  const top: UsageRecord[] = [];
  for (const r of records) {
    if (top.length < 3) {
      top.push(r);
      top.sort((a, b) => b.response_bytes - a.response_bytes);
    } else if (r.response_bytes > top[2].response_bytes) {
      if (r.response_bytes > top[0].response_bytes) {
        top[2] = top[1];
        top[1] = top[0];
        top[0] = r;
      } else if (r.response_bytes > top[1].response_bytes) {
        top[2] = top[1];
        top[1] = r;
      } else {
        top[2] = r;
      }
    }
  }

  const top_responses: UsageTopResponse[] = top.map((r) => ({
    action: r.action,
    response_bytes: r.response_bytes,
  }));

  return {
    session_id: sessionId,
    connector,
    start,
    end,
    total_calls: records.length,
    total_response_bytes: totalBytes,
    total_estimated_tokens: totalTokens,
    error_rate: errors / records.length,
    by_action,
    top_responses,
  };
}

export function renderSummaryMarkdown(s: UsageSummary): string {
  if (s.total_calls === 0) {
    return `# ${s.connector} usage — session ${s.session_id}\n\nNo calls recorded.\n`;
  }
  const successes = s.total_calls - Math.round(s.error_rate * s.total_calls);
  const errors = s.total_calls - successes;
  const rows = Object.entries(s.by_action)
    .sort(([, a], [, b]) => b.response_bytes - a.response_bytes)
    .map(
      ([action, a]) =>
        `| ${action} | ${a.calls} | ${a.response_bytes.toLocaleString()} | ${a.estimated_tokens.toLocaleString()} | ${a.avg_ms} |`,
    )
    .join("\n");

  const top = s.top_responses
    .map(
      (t, i) =>
        `${i + 1}. ${t.action} (${t.response_bytes.toLocaleString()} bytes)`,
    )
    .join("\n");

  return [
    `# ${s.connector} usage — session ${s.session_id}`,
    ``,
    `- Window: ${s.start} → ${s.end}`,
    `- Calls: ${s.total_calls} (${successes} success, ${errors} error — ${(s.error_rate * 100).toFixed(1)}%)`,
    `- Response bytes: ${s.total_response_bytes.toLocaleString()} | Estimated tokens: ${s.total_estimated_tokens.toLocaleString()}`,
    ``,
    `## By action`,
    ``,
    `| action | calls | bytes | est. tokens | avg ms |`,
    `|---|---|---|---|---|`,
    rows,
    ``,
    `## Top responses`,
    ``,
    top,
    ``,
  ].join("\n");
}
