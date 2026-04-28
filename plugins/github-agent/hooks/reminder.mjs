#!/usr/bin/env node
/**
 * SessionStart curation reminder for the GitHub connector.
 */
try {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data) process.exit(0);
  const toolkitEntry = `${data}/node_modules/@narai/connector-toolkit/dist/plugin/reminder.js`;
  const mod = await import(toolkitEntry);
  const decision = mod.evaluateNudge({ connectors: ["github"] });
  if (decision.nudge) {
    process.stdout.write(decision.banner + "\n");
  }
} catch {
  // best-effort — reminder never blocks startup
}
