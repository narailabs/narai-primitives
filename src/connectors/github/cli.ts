#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * GitHub token / default owner to `process.env`. Existing exports win —
 * the bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const GITHUB_ENV_MAPPING: Record<string, string> = {
  token: "GITHUB_TOKEN",
  owner: "GITHUB_OWNER",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("github", { envMapping: GITHUB_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
