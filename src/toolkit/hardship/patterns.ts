/**
 * patterns.ts — load patterns.yaml, match hardship facts, produce hints.
 *
 * Hot-path: called on every non-success envelope. Cached with mtime
 * invalidation so a freshly-curated patterns.yaml is picked up without
 * restart (within the same process).
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";

// js-yaml is a direct toolkit dependency (see package.json). Use createRequire
// for sync loading from an ESM module; dynamic import() would force the hot
// path to be async.
const requireSync = createRequire(import.meta.url);

export interface PatternMatcher {
  context_regex?: string;
}

export interface Pattern {
  pattern_id: string;
  status: "active" | "draft";
  confidence: number;
  kind: string;
  actions?: string[];
  matcher: PatternMatcher;
  advice: string;
}

export interface PatternsFile {
  version: number;
  last_updated?: string;
  patterns: Pattern[];
}

export interface HardshipFacts {
  kind: string;
  action: string;
  context: string;
}

export interface MatchedPattern {
  pattern_id: string;
  advice: string;
  confidence: number;
}

// Cache: path → { mtimeMs, file }
interface CacheEntry {
  mtimeMs: number;
  file: PatternsFile;
}
const cache = new Map<string, CacheEntry>();

const EMPTY: PatternsFile = { version: 1, patterns: [] };

function isPattern(obj: unknown): obj is Pattern {
  if (!obj || typeof obj !== "object") return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p["pattern_id"] === "string" &&
    (p["status"] === "active" || p["status"] === "draft") &&
    typeof p["confidence"] === "number" &&
    typeof p["kind"] === "string" &&
    typeof p["advice"] === "string" &&
    typeof p["matcher"] === "object" &&
    p["matcher"] !== null
  );
}

export function loadPatterns(filePath: string): PatternsFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return EMPTY;
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.file;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return EMPTY;
  }

  const yaml = requireSync("js-yaml") as typeof import("js-yaml");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY;
  const p = parsed as Record<string, unknown>;
  const rawPatterns = Array.isArray(p["patterns"]) ? p["patterns"] : [];
  const file: PatternsFile = {
    version: typeof p["version"] === "number" ? p["version"] : 1,
    ...(typeof p["last_updated"] === "string"
      ? { last_updated: p["last_updated"] }
      : {}),
    patterns: rawPatterns.filter(isPattern),
  };
  cache.set(filePath, { mtimeMs: stat.mtimeMs, file });
  return file;
}

export function matchPattern(
  patterns: readonly Pattern[],
  facts: HardshipFacts,
): MatchedPattern | null {
  for (const p of patterns) {
    if (p.status !== "active") continue;
    if (p.kind !== facts.kind) continue;
    if (p.actions && p.actions.length > 0 && !p.actions.includes(facts.action)) {
      continue;
    }
    if (p.matcher.context_regex) {
      try {
        if (!new RegExp(p.matcher.context_regex).test(facts.context)) continue;
      } catch {
        continue; // malformed regex — skip pattern
      }
    }
    return {
      pattern_id: p.pattern_id,
      advice: p.advice,
      confidence: p.confidence,
    };
  }
  return null;
}

/** Test helper — clear the mtime cache. */
export function _resetPatternCache(): void {
  cache.clear();
}
