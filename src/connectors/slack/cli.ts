#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * Slack tokens / default team id to `process.env`. Existing exports win — the
 * bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const SLACK_ENV_MAPPING: Record<string, string> = {
  bot_token: "SLACK_BOT_TOKEN",
  user_token: "SLACK_USER_TOKEN",
  default_team_id: "SLACK_DEFAULT_TEAM_ID",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("slack", { envMapping: SLACK_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
