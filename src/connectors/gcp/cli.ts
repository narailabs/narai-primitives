#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * GCP project / region / credentials path to `process.env`. Existing exports
 * win — the bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const GCP_ENV_MAPPING: Record<string, string> = {
  project_id: "GCP_PROJECT_ID",
  region: "GCP_REGION",
  credentials: "GOOGLE_APPLICATION_CREDENTIALS",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("gcp", { envMapping: GCP_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
