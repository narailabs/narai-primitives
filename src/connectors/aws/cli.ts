#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * AWS credentials/region to `process.env` so the SDK picks them up via the
 * default credential chain. Existing exports of `AWS_ACCESS_KEY_ID` etc.
 * win — the bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const AWS_ENV_MAPPING: Record<string, string> = {
  access_key_id: "AWS_ACCESS_KEY_ID",
  secret_access_key: "AWS_SECRET_ACCESS_KEY",
  session_token: "AWS_SESSION_TOKEN",
  region: "AWS_DEFAULT_REGION",
  profile: "AWS_PROFILE",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("aws", { envMapping: AWS_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
