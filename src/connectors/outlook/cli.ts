#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by the connector hub) before `main()` runs and applies any configured
 * Microsoft Graph credentials to `process.env`. Existing exports win — the
 * bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const OUTLOOK_ENV_MAPPING: Record<string, string> = {
  tenant_id: "MS_TENANT_ID",
  client_id: "MS_CLIENT_ID",
  client_secret: "MS_CLIENT_SECRET",
  refresh_token: "MS_REFRESH_TOKEN",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("outlook", { envMapping: OUTLOOK_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
