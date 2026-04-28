#!/usr/bin/env node
/**
 * SessionStart curation reminder. Runs after the install hook.
 *
 * Imports `evaluateNudge` from the installed toolkit (lives under
 * `${CLAUDE_PLUGIN_DATA}/node_modules`), checks thresholds + user skip
 * state in `~/.claude/connectors/curation-prefs.json`, and prints one
 * banner line if the Confluence connector has uncurated hardship entries
 * worth reviewing.
 *
 * Non-failing: any error (missing toolkit, unreadable prefs, etc.) is
 * swallowed. A missing nudge is better than a noisy session start.
 */
try {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data) process.exit(0);
  const toolkitEntry = `${data}/node_modules/@narai/connector-toolkit/dist/plugin/reminder.js`;
  const mod = await import(toolkitEntry);
  const decision = mod.evaluateNudge({ connectors: ["confluence"] });
  if (decision.nudge) {
    process.stdout.write(decision.banner + "\n");
  }
} catch {
  // best-effort — reminder never blocks startup
}
