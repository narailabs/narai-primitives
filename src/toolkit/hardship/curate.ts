/**
 * Curation helpers. Cluster raw JSONL hardships into proposed MD promotions.
 *
 * Curation happens in two phases:
 *
 *   1. Cluster — deterministic, no LLM: group entries by
 *      (connector, action, kind, normalized context key). Pure text work.
 *   2. Promote — LLM-assisted: given clusters, propose which section of the
 *      MD file they belong in (Auth & Tokens / Rate Limits / ...) and write
 *      a human-readable summary. This module provides the *structure*;
 *      the actual LLM prompting is invoked by the `/connector-curate`
 *      slash command (which embeds prompt text that reads + invokes these
 *      helpers via the connector CLI).
 */
import type { HardshipEntry } from "./record.js";

export interface HardshipCluster {
  signature: string;           // stable hash of the cluster key
  connector: string;
  action: string;
  kind: string;
  scope: string | null;
  count: number;
  first_ts: string;
  last_ts: string;
  sample_contexts: string[];   // up to 5 distinct normalized contexts
  sample_resolutions: string[]; // up to 5 distinct resolutions
  sessions: string[];          // distinct session_ids (if present)
}

/**
 * Normalize a free-form context string so minor differences (whitespace,
 * timestamps, UUIDs) collapse into the same cluster.
 */
export function normalizeContext(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.z+-]*/g, "<ts>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b\d{6,}\b/g, "<num>")
    .trim();
}

function clusterKey(entry: HardshipEntry): string {
  return [
    entry.connector,
    entry.action,
    entry.kind,
    entry.scope ?? "",
    normalizeContext(entry.context),
  ].join("\0");
}

function addUnique<T>(list: T[], item: T, cap: number): void {
  if (list.length >= cap) return;
  if (!list.includes(item)) list.push(item);
}

/**
 * Cluster a flat list of entries. Stable output: clusters are sorted by
 * count descending, then by last_ts descending.
 */
export function clusterHardships(
  entries: readonly HardshipEntry[],
): HardshipCluster[] {
  const byKey = new Map<string, HardshipCluster>();
  for (const e of entries) {
    const key = clusterKey(e);
    let cluster = byKey.get(key);
    if (cluster === undefined) {
      cluster = {
        signature: key,
        connector: e.connector,
        action: e.action,
        kind: e.kind,
        scope: e.scope ?? null,
        count: 0,
        first_ts: e.ts,
        last_ts: e.ts,
        sample_contexts: [],
        sample_resolutions: [],
        sessions: [],
      };
      byKey.set(key, cluster);
    }
    cluster.count += 1;
    if (e.ts < cluster.first_ts) cluster.first_ts = e.ts;
    if (e.ts > cluster.last_ts) cluster.last_ts = e.ts;
    addUnique(cluster.sample_contexts, e.context, 5);
    if (e.resolution !== undefined && e.resolution.length > 0) {
      addUnique(cluster.sample_resolutions, e.resolution, 5);
    }
    if (e.session_id !== undefined) addUnique(cluster.sessions, e.session_id, 10);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => b.count - a.count || (b.last_ts < a.last_ts ? 1 : -1),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Curation marker — stored as MD frontmatter on `hardships.md`.
// ───────────────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface CurationMarker {
  last_curated_ts: string | null;
  last_curated_count: number;
}

export function readCurationMarker(md: string): CurationMarker {
  const match = FRONTMATTER_RE.exec(md);
  if (!match) return { last_curated_ts: null, last_curated_count: 0 };
  const body = match[1]!;
  const lines = body.split("\n");
  let ts: string | null = null;
  let count = 0;
  for (const line of lines) {
    const [k, ...rest] = line.split(":");
    if (!k) continue;
    const value = rest.join(":").trim();
    if (k.trim() === "last_curated_ts") {
      ts = value || null;
    } else if (k.trim() === "last_curated_count") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) count = parsed;
    }
  }
  return { last_curated_ts: ts, last_curated_count: count };
}

export function writeCurationMarker(md: string, marker: CurationMarker): string {
  const frontmatter = [
    "---",
    `last_curated_ts: ${marker.last_curated_ts ?? ""}`,
    `last_curated_count: ${marker.last_curated_count}`,
    "---",
    "",
  ].join("\n");
  const stripped = md.replace(FRONTMATTER_RE, "");
  return frontmatter + stripped;
}

/** Filter entries newer than the last-curated timestamp. */
export function entriesSinceLastCuration(
  entries: readonly HardshipEntry[],
  marker: CurationMarker,
): HardshipEntry[] {
  if (marker.last_curated_ts === null) return [...entries];
  return entries.filter((e) => e.ts > marker.last_curated_ts!);
}
