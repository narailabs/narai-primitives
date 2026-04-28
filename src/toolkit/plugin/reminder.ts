/**
 * SessionStart reminder. Checks thresholds + skip-state, emits one banner
 * line if a nudge is warranted. Designed to be called from a connector's
 * `plugin/hooks/hooks.json` SessionStart handler.
 *
 * Throttle: at most one banner per `skip_until_ts` window per user. The
 * window updates only when the user invokes `/connector-curate skip`;
 * reading this function repeatedly in-session is safe (idempotent).
 */
import { countRawHardships } from "../hardship/read.js";
import { readCurationMarker } from "../hardship/curate.js";
import { resolveTierPaths } from "../hardship/scope.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPrefs, type CurationPrefs } from "./prefs.js";

export interface NudgeContext {
  /** Connector names to consider. */
  connectors: readonly string[];
  /** Override home (tests). */
  home?: string;
  /** Override cwd (tests). */
  cwd?: string;
  /** Override now (tests). */
  now?: Date;
}

export interface NudgeDecision {
  nudge: boolean;
  banner: string;
  reason: string;
  triggered_by: Array<{
    connector: string;
    new_entries: number;
    days_since_curate: number | null;
  }>;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

function readMdMarker(connector: string, cwd: string, home: string) {
  // Walk global tiers (project-global, user-global) — curation writes to the
  // same tier the writer routes null-scope entries into.
  const tiers = resolveTierPaths({ connector, scope: null, cwd, home });
  for (const t of tiers) {
    const md = path.join(t.dir, "hardships.md");
    try {
      const contents = fs.readFileSync(md, "utf-8");
      return readCurationMarker(contents);
    } catch {
      // try next tier
    }
  }
  return { last_curated_ts: null, last_curated_count: 0 };
}

/**
 * Pure-function evaluation. Returns a decision; caller prints the banner
 * when `nudge` is true. Writes nothing.
 */
export function evaluateNudge(ctx: NudgeContext): NudgeDecision {
  const home = ctx.home ?? os.homedir();
  const cwd = ctx.cwd ?? process.cwd();
  const now = ctx.now ?? new Date();
  const prefs: CurationPrefs = readPrefs(home);

  if (!prefs.enabled) {
    return { nudge: false, banner: "", reason: "disabled", triggered_by: [] };
  }
  if (prefs.skip_until_ts !== null) {
    const skipUntil = new Date(prefs.skip_until_ts);
    if (!Number.isNaN(skipUntil.getTime()) && now < skipUntil) {
      return {
        nudge: false,
        banner: "",
        reason: `skipped until ${prefs.skip_until_ts}`,
        triggered_by: [],
      };
    }
  }

  const triggered: NudgeDecision["triggered_by"] = [];
  let totalNew = 0;

  for (const connector of ctx.connectors) {
    const total = countRawHardships(connector, { cwd, home });
    const marker = readMdMarker(connector, cwd, home);
    const newCount = Math.max(0, total - marker.last_curated_count);
    const days =
      marker.last_curated_ts !== null
        ? daysBetween(new Date(marker.last_curated_ts), now)
        : null;

    const hitCount = newCount >= prefs.min_new_entries;
    const hitDays = days !== null && days >= prefs.max_days_since_curate;

    if (hitCount || hitDays) {
      triggered.push({
        connector,
        new_entries: newCount,
        days_since_curate: days,
      });
      totalNew += newCount;
    }
  }

  if (triggered.length === 0) {
    return {
      nudge: false,
      banner: "",
      reason: "no connector met threshold",
      triggered_by: [],
    };
  }

  const connList = triggered.map((t) => t.connector).join(", ");
  const banner = [
    `[connectors] ${totalNew} uncurated hardships in ${connList}.`,
    `            /connector-curate to review, /connector-curate skip for 1d,`,
    `            skip --week for 7d, off to disable.`,
  ].join("\n");

  return { nudge: true, banner, reason: "threshold met", triggered_by: triggered };
}

/** Print the banner to stdout if the nudge fires. Used directly by hooks. */
export function printNudgeIfNeeded(ctx: NudgeContext): void {
  const d = evaluateNudge(ctx);
  if (d.nudge) {
    // eslint-disable-next-line no-console
    console.log(d.banner);
  }
}
