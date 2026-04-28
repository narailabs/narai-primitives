/**
 * Curation preferences — user-global JSON at `~/.claude/connectors/curation-prefs.json`.
 *
 * Persists the throttle + enabled state for the curation-reminder banner.
 * Writes are best-effort (ENOENT auto-creates parent dirs; any other error
 * is swallowed so the SessionStart hook never blocks session startup).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CurationPrefs {
  enabled: boolean;
  min_new_entries: number;
  max_days_since_curate: number;
  /** ISO-8601 timestamp; banners are suppressed until `now > skip_until_ts`. */
  skip_until_ts: string | null;
}

export const DEFAULT_PREFS: CurationPrefs = {
  enabled: true,
  min_new_entries: 5,
  max_days_since_curate: 7,
  skip_until_ts: null,
};

export function prefsPath(home: string = os.homedir()): string {
  return path.join(home, ".claude", "connectors", "curation-prefs.json");
}

function isValidPrefs(v: unknown): v is CurationPrefs {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["enabled"] === "boolean" &&
    typeof o["min_new_entries"] === "number" &&
    typeof o["max_days_since_curate"] === "number" &&
    (o["skip_until_ts"] === null || typeof o["skip_until_ts"] === "string")
  );
}

export function readPrefs(home: string = os.homedir()): CurationPrefs {
  const p = prefsPath(home);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return { ...DEFAULT_PREFS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidPrefs(parsed)) return parsed;
  } catch {
    // fall through to defaults on parse error
  }
  return { ...DEFAULT_PREFS };
}

export function writePrefs(
  prefs: CurationPrefs,
  home: string = os.homedir(),
): void {
  const p = prefsPath(home);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic write: write to sibling tmp file then rename.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, p);
  } catch {
    // best-effort
  }
}

/** Set `skip_until_ts` to `now + days` (or revert to `null` if `days <= 0`). */
export function setSkipDays(
  days: number,
  now: Date = new Date(),
  home: string = os.homedir(),
): void {
  const prefs = readPrefs(home);
  if (days <= 0) {
    prefs.skip_until_ts = null;
  } else {
    const target = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    prefs.skip_until_ts = target.toISOString();
  }
  writePrefs(prefs, home);
}

export function setEnabled(
  enabled: boolean,
  home: string = os.homedir(),
): void {
  const prefs = readPrefs(home);
  prefs.enabled = enabled;
  writePrefs(prefs, home);
}
