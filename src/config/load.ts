/**
 * File discovery, YAML parsing, and base-level deep merge for
 * ~/.connectors/config.yaml + ./.connectors/config.yaml.
 *
 * The repo-level file wins on conflict. The environment + consumer
 * overrides are applied in resolve.ts on top of this base.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "js-yaml";

import type { LoadOptions, ResolvedConfig } from "./types.js";
import { resolveConfig } from "./resolve.js";
import { validateSecretsInTree } from "./secrets.js";

/** Absolute path to the user-level config: `~/.connectors/config.yaml`. */
export function userConfigPath(): string {
  return path.join(os.homedir(), ".connectors", "config.yaml");
}

/** Absolute path to the repo-level config under `cwd`. */
export function repoConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".connectors", "config.yaml");
}

/**
 * Read a single YAML file and return its parsed mapping.
 *
 * - Returns `{}` if the file does not exist or contains nothing.
 * - Throws on parse error or if the top-level value is not a mapping.
 */
export function loadFile(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML at ${p}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected YAML mapping at ${p}, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Deep merge of two values. Plain objects merge recursively; arrays and
 * scalars are replaced wholesale by the overlay. Undefined overlay leaves
 * the base unchanged.
 */
export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const baseObj = base as Record<string, unknown>;
    const overlayObj = overlay as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>([
      ...Object.keys(baseObj),
      ...Object.keys(overlayObj),
    ]);
    for (const k of keys) {
      result[k] = deepMerge(baseObj[k], overlayObj[k]);
    }
    return result;
  }
  return overlay;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read user + repo files and deep-merge with repo precedence. Either or
 * both may be missing.
 */
export function loadBaseConfig(cwd: string = process.cwd()): Record<string, unknown> {
  const user = loadFile(userConfigPath());
  const repo = loadFile(repoConfigPath(cwd));
  const merged = deepMerge(user, repo);
  return (merged ?? {}) as Record<string, unknown>;
}

/**
 * The main public entry point: load + validate secret syntax + apply
 * environment + consumer overrides. Returns a `ResolvedConfig` ready to
 * iterate by the hub or sliced by a standalone connector.
 */
export async function loadResolvedConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const raw = loadBaseConfig(opts.cwd);
  validateSecretsInTree(raw);
  const resolveOpts: { consumer?: string; environment?: string } = {};
  if (opts.consumer !== undefined) resolveOpts.consumer = opts.consumer;
  if (opts.environment !== undefined) resolveOpts.environment = opts.environment;
  return resolveConfig(raw, resolveOpts);
}
