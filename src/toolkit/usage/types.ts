/** One line in <session-id>.jsonl — written by the PostToolUse hook. */
export interface UsageRecord {
  ts: string;               // ISO-8601 UTC, ms precision, trailing "Z"
  session_id: string;
  connector: string;        // e.g. "github"
  action: string;           // e.g. "repo_info", or "unknown"
  status: string;           // "success" | "error" | "unparseable" | ...
  response_bytes: number;
  estimated_tokens: number; // Math.ceil(response_bytes / 4)
  execution_time_ms?: number;
}

export interface UsageActionBreakdown {
  calls: number;
  response_bytes: number;
  estimated_tokens: number;
  avg_ms: number;           // 0 if no execution_time_ms values present
}

export interface UsageTopResponse {
  action: string;
  response_bytes: number;
}

export interface UsageSummary {
  session_id: string;
  connector: string;
  start: string;            // earliest ts in the session
  end: string;              // latest ts
  total_calls: number;
  total_response_bytes: number;
  total_estimated_tokens: number;
  error_rate: number;       // 0–1
  by_action: Record<string, UsageActionBreakdown>;
  top_responses: UsageTopResponse[]; // up to 3, sorted desc
}
