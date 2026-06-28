/**
 * naming.ts — migration-safe resolution of the connector's config base
 * directory and env-var prefix.
 *
 * Resolution order (both helpers):
 *   1. explicit override (opt-in)
 *   2. legacy location/prefix when it is already in use (so existing
 *      adopters never silently lose credentials, grants, or env vars)
 *   3. neutral default
 *
 * The legacy names are retained only as a fallback; new users get the
 * neutral default.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LEGACY_DIR = "wiki_db";
const NEUTRAL_DIR = path.join("narai", "db");
const LEGACY_ENV_PREFIX = "WIKI_DB_";
const NEUTRAL_ENV_PREFIX = "NARAI_DB_";

/** Config base dir: explicit override > legacy if it exists > neutral default. */
export function configBaseDir(override?: string): string {
  if (override !== undefined) return override;
  const legacy = path.join(os.homedir(), ".config", LEGACY_DIR);
  if (fs.existsSync(legacy)) return legacy;
  return path.join(os.homedir(), ".config", NEUTRAL_DIR);
}

/** Env prefix: explicit override > legacy if any WIKI_DB_* var is set > neutral. */
export function envVarPrefix(override?: string): string {
  if (override !== undefined) return override;
  const hasLegacy = Object.keys(process.env).some((k) =>
    k.startsWith(LEGACY_ENV_PREFIX),
  );
  return hasLegacy ? LEGACY_ENV_PREFIX : NEUTRAL_ENV_PREFIX;
}
