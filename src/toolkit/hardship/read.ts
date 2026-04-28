/**
 * Reader for hardship artifacts. 4-tier walk (project-tenant → project-global
 * → user-tenant → user-global); non-existent tier files are skipped.
 *
 *   project-tenant: <cwd>/.claude/connectors/<name>/tenants/<hash>/{hardships.jsonl,hardships.md}
 *   project-global: <cwd>/.claude/connectors/<name>/global/{hardships.jsonl,hardships.md}
 *   user-tenant:    <home>/.claude/connectors/<name>/tenants/<hash>/{hardships.jsonl,hardships.md}
 *   user-global:    <home>/.claude/connectors/<name>/global/{hardships.jsonl,hardships.md}
 *
 * When `scope` is null, only the two `-global` tiers are walked.
 *
 * MD is merged: each tier's file is concatenated in tier order with a
 * divider; empty / missing tiers are skipped. Agents reading the MD see
 * most-specific guidance first. Sections with identical headings are NOT
 * auto-merged — that is the curation step's job.
 *
 * JSONL is concatenated across all tiers, then sorted newest-first by `ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HardshipEntry } from "./record.js";
import { resolveTierPaths, type TierName } from "./scope.js";
import {
  loadPatterns,
  matchPattern,
  type HardshipFacts,
  type MatchedPattern,
} from "./patterns.js";

export interface ReadOptions {
  cwd?: string;
  home?: string;
  /** Tenant scope; null (default) walks only the global tiers. */
  scope?: string | null;
}

interface TieredFile {
  tier: TierName;
  path: string;
}

/** Return candidate file paths across all tiers (existence not checked). */
function hardshipPaths(
  connector: string,
  opts: ReadOptions,
  filename: "hardships.jsonl" | "hardships.md",
): TieredFile[] {
  const tiers = resolveTierPaths({
    connector,
    scope: opts.scope ?? null,
    cwd: opts.cwd ?? process.cwd(),
    home: opts.home ?? process.env["HOME"] ?? "/",
  });
  return tiers.map((t) => ({ tier: t.name, path: path.join(t.dir, filename) }));
}

function tryReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Load the curated MD for a connector across all tiers. Each tier's file,
 * if present, is concatenated in tier order (most specific first) separated
 * by a visible divider. Returns `""` when no tier has content.
 */
export function readCuratedHardships(
  connector: string,
  opts: ReadOptions = {},
): string {
  const files = hardshipPaths(connector, opts, "hardships.md");
  const parts: string[] = [];
  for (const f of files) {
    const raw = tryReadFile(f.path);
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    parts.push(`<!-- layer: ${f.tier} (${f.path}) -->\n${trimmed}`);
  }
  return parts.join("\n\n---\n\n");
}

/** Load raw JSONL entries, newest-first, across all tiers combined. */
export function readRawHardships(
  connector: string,
  opts: ReadOptions = {},
): HardshipEntry[] {
  const files = hardshipPaths(connector, opts, "hardships.jsonl");
  const entries: HardshipEntry[] = [];
  for (const f of files) {
    const raw = tryReadFile(f.path);
    if (raw === null) continue;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isHardshipEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed lines silently.
      }
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries;
}

function isHardshipEntry(v: unknown): v is HardshipEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["ts"] === "string" &&
    typeof o["connector"] === "string" &&
    typeof o["action"] === "string" &&
    typeof o["kind"] === "string" &&
    typeof o["context"] === "string"
  );
}

/** Count JSONL entries for a connector across all tiers. Used by the reminder. */
export function countRawHardships(
  connector: string,
  opts: ReadOptions = {},
): number {
  return readRawHardships(connector, opts).length;
}

export interface ReadFirstMatchingPatternOptions {
  connector: string;
  scope: string | null;
  cwd?: string;
  home?: string;
  facts: HardshipFacts;
}

export interface TierMatch {
  tier: TierName;
  match: MatchedPattern;
  /** "tenant" if the tier included a tenant hash, "global" otherwise. */
  scopeLevel: "tenant" | "global";
}

export function readFirstMatchingPattern(
  opts: ReadFirstMatchingPatternOptions,
): TierMatch | null {
  const tiers = resolveTierPaths({
    connector: opts.connector,
    scope: opts.scope,
    cwd: opts.cwd ?? process.cwd(),
    home: opts.home ?? process.env["HOME"] ?? "/",
  });
  for (const tier of tiers) {
    const file = loadPatterns(path.join(tier.dir, "patterns.yaml"));
    const match = matchPattern(file.patterns, opts.facts);
    if (match) {
      return { tier: tier.name, match, scopeLevel: tier.scopeLevel };
    }
  }
  return null;
}
