import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageRecord } from "./types.js";

/**
 * Append one UsageRecord as a JSON line to the given path. Creates parent
 * directories as needed. Swallows all errors (hooks must never break the
 * caller). Returns true on success, false on failure.
 */
export function appendUsageRecord(path: string, record: UsageRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
