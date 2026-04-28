#!/usr/bin/env node
/**
 * SessionStart curation reminder for the Notion connector.
 * See Confluence connector for pattern docs.
 */
try {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data) process.exit(0);
  const toolkitEntry = `${data}/node_modules/narai-primitives/dist/toolkit/plugin/reminder.js`;
  const mod = await import(toolkitEntry);
  const decision = mod.evaluateNudge({ connectors: ["notion"] });
  if (decision.nudge) {
    process.stdout.write(decision.banner + "\n");
  }
} catch {
  // best-effort — reminder never blocks startup
}
