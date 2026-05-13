#!/usr/bin/env node
/**
 * Thin bin entry. Library code lives in index.ts.
 *
 * Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB`, when injected
 * by `@narai/connector-hub`) before `main()` runs and applies any configured
 * GitLab token / default namespace to `process.env`. Existing exports win —
 * the bootstrap only fills in undefined entries.
 */
import { loadConnectorEnvironment } from "narai-primitives/config";
import connector from "./index.js";

const GITLAB_ENV_MAPPING: Record<string, string> = {
  token: "GITLAB_TOKEN",
  host: "GITLAB_HOST",
  namespace: "GITLAB_NAMESPACE",
};

async function run(): Promise<number> {
  await loadConnectorEnvironment("gitlab", { envMapping: GITLAB_ENV_MAPPING });
  return connector.main(process.argv.slice(2));
}

void run().then((code) => {
  process.exit(code);
});
