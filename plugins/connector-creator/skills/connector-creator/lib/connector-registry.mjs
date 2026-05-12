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
    let raw;
    try {
      raw = fs.readFileSync(file, "utf-8");
      parsed = yaml.load(raw) ?? {};
    } catch (err) {
      // Fail closed: a malformed config.yaml (often from in-progress
      // user edits) must not silently overwrite existing entries. Throw
      // so the caller can surface the parse error and let the user fix
      // their YAML before we mutate anything.
      throw new Error(
        `registerConnector: refusing to overwrite '${file}' — parse failed (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
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
