#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * Confluence site / email / api token to `process.env`. Existing exports
 * win — the bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const CONFLUENCE_ENV_MAPPING: Record<string, string> = {
  site_url: "CONFLUENCE_SITE_URL",
  email: "CONFLUENCE_EMAIL",
  api_token: "CONFLUENCE_API_TOKEN",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("confluence", { envMapping: CONFLUENCE_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
