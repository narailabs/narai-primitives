#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * Linear API key to `process.env`. Existing exports win — the bootstrap only
 * fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const LINEAR_ENV_MAPPING: Record<string, string> = {
  api_key: "LINEAR_API_KEY",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("linear", { envMapping: LINEAR_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
