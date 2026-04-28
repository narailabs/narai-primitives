/**
 * `/connector-curate` helper.
 *
 * Each connector CLI accepts a `--curate` flag (wired by the factory). When
 * set, the CLI prints a JSON snapshot of uncurated hardship clusters plus
 * the current curation marker to stdout and exits 0. The slash command's
 * prompt text reads that JSON, proposes promotions into MD sections, asks
 * the user to approve, and then edits the MD directly via Claude Code's
 * Edit tool.
 *
 * The write-back (promoting approved clusters into semantic sections) is
 * handled by Claude via Edit — NOT by this module. This keeps the curation
 * logic in prompt-space where judgement and diffing are legible.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clusterHardships,
  entriesSinceLastCuration,
  readCurationMarker,
  type HardshipCluster,
  type CurationMarker,
} from "../hardship/curate.js";
import { readCuratedHardships, readRawHardships } from "../hardship/read.js";
import { resolveTierPaths } from "../hardship/scope.js";

export interface CurateSnapshot {
  connector: string;
  total_entries: number;
  new_entries: number;
  marker: CurationMarker;
  clusters: HardshipCluster[];
  curated_md: string;
  paths: {
    /** Absolute path to the MD file that the slash command should edit. */
    target_md: string;
    /** Absolute paths to every JSONL file read (project-local, user-global). */
    read_from: string[];
  };
}

export interface CurateCommandOptions {
  connector: string;
  cwd?: string;
  home?: string;
}

export function buildCurateSnapshot(
  opts: CurateCommandOptions,
): CurateSnapshot {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();

  const raw = readRawHardships(opts.connector, { cwd, home });
  const curatedMd = readCuratedHardships(opts.connector, { cwd, home });

  // Null-scope tier walk: project-global, user-global (most specific first).
  const tiers = resolveTierPaths({
    connector: opts.connector,
    scope: null,
    cwd,
    home,
  });

  // Target MD = most-specific tier that's writable. project-global if
  // <cwd>/.claude/ exists; else user-global.
  const hasProject = fs.existsSync(path.join(cwd, ".claude"));
  const targetTier =
    tiers.find((t) => (hasProject ? true : !t.name.startsWith("project-"))) ??
    tiers[tiers.length - 1]!;
  const targetMd = path.join(targetTier.dir, "hardships.md");

  // Read the marker from the target file directly — `curatedMd` from
  // `readCuratedHardships` prepends HTML comments which break frontmatter
  // parsing. The target is where the next curation will write, so it's
  // the authoritative source for the marker.
  let targetMdRaw = "";
  try {
    targetMdRaw = fs.readFileSync(targetMd, "utf-8");
  } catch {
    // Target doesn't exist yet; marker defaults apply.
  }
  const marker = readCurationMarker(targetMdRaw);
  const since = entriesSinceLastCuration(raw, marker);
  const clusters = clusterHardships(since);
  const readFrom: string[] = [];
  for (const t of tiers) {
    const jsonl = path.join(t.dir, "hardships.jsonl");
    if (fs.existsSync(jsonl)) readFrom.push(jsonl);
  }

  return {
    connector: opts.connector,
    total_entries: raw.length,
    new_entries: since.length,
    marker,
    clusters,
    curated_md: curatedMd,
    paths: {
      target_md: targetMd,
      read_from: readFrom,
    },
  };
}
