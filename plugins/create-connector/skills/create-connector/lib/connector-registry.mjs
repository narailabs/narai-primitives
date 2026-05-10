import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

/**
 * Register a connector under <scope>/.connectors/config.yaml.
 *
 * Creates the file with `connectors: {}` if missing. Idempotent: re-running
 * with the same slug overwrites that slug's block but does not duplicate.
 */
export function registerConnector(scope, slug, entry) {
  const file = path.join(scope, ".connectors", "config.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let parsed = { connectors: {} };
  if (fs.existsSync(file)) {
    try {
      parsed = yaml.load(fs.readFileSync(file, "utf-8")) ?? {};
    } catch {
      parsed = {};
    }
    if (!parsed.connectors || typeof parsed.connectors !== "object") {
      parsed.connectors = {};
    }
  }

  parsed.connectors[slug] = {
    ...entry,
    enabled: true,
  };

  fs.writeFileSync(file, yaml.dump(parsed, { lineWidth: 120 }));
}
