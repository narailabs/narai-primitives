/**
 * preamble.ts — render the session-start "Known gotchas" markdown block
 * for a connector. Called from each connector's SKILL.md plugin loader.
 */
import * as path from "node:path";
import { resolveTierPaths } from "./scope.js";
import { loadPatterns, type Pattern } from "./patterns.js";

export interface RenderSkillPreambleOptions {
  connector: string;
  scope?: string | null;
  cwd?: string;
  home?: string;
}

/**
 * Walk all 4 tiers and collect every active pattern. Dedupe by pattern_id
 * preferring the most-specific tier's version. Return a markdown block
 * or "" if there are no active patterns.
 */
export function renderSkillPreamble(
  opts: RenderSkillPreambleOptions,
): string {
  const scope = opts.scope ?? null;
  const tiers = resolveTierPaths({
    connector: opts.connector,
    scope,
    cwd: opts.cwd ?? process.cwd(),
    home: opts.home ?? process.env["HOME"] ?? "/",
  });
  const seen = new Map<string, Pattern>();
  for (const t of tiers) {
    const file = loadPatterns(path.join(t.dir, "patterns.yaml"));
    for (const p of file.patterns) {
      if (p.status !== "active") continue;
      if (!seen.has(p.pattern_id)) {
        seen.set(p.pattern_id, p);
      }
    }
  }
  if (seen.size === 0) return "";
  const bullets: string[] = [];
  for (const p of seen.values()) {
    const firstLine = p.advice.split("\n")[0]?.trim() ?? "";
    bullets.push(`- **${p.pattern_id}**: ${firstLine}`);
  }
  return [
    `## Known gotchas (auto — ${opts.connector})`,
    ...bullets,
    "",
    `_Auto-injected from curated hardships. Run \`/curate\` to refresh._`,
    "",
  ].join("\n");
}
