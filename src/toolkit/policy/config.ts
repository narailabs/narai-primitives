/**
 * Operator-facing config loader. Discovers two YAML files for each connector:
 *
 *   1. `~/.<name>-agent/config.yaml`   — user-level base
 *   2. `<cwd>/.<name>-agent/config.yaml` — repo-level overlay (wins on collision)
 *
 * Plus an optional explicit path (caller-provided). Returns validated
 * `PolicyRules` + `ApprovalMode`, or `null` if no config is discovered and no
 * explicit path is given — callers fall through to `DEFAULT_POLICY` + `"auto"`.
 *
 * Safety floor: `admin` can never be `"success"` in config. Connectors can
 * declare additional floor aspects (e.g., db-agent declares `ddl`, `privilege`);
 * those aspects are also rejected if set to `"success"`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  DEFAULT_POLICY,
  type ApprovalMode,
  type PolicyRules,
  type RestrictedRule,
  type Rule,
} from "./types.js";

const VALID_RULES: ReadonlySet<Rule> = new Set([
  "success",
  "escalate",
  "denied",
]);

const VALID_APPROVAL_MODES: ReadonlySet<ApprovalMode> = new Set([
  "auto",
  "confirm_once",
  "confirm_each",
  "grant_required",
]);

export interface LoadedPolicy {
  rules: PolicyRules;
  approval_mode: ApprovalMode;
}

export interface LoadPolicyConfigOptions {
  /** Connector name — shapes the discovery path `~/.<name>-agent/config.yaml`. */
  name: string;
  /** Aspects that cannot be downgraded to `"success"` by operator config. */
  floorAspects?: readonly string[];
  /** Explicit path (overrides discovery). */
  explicitPath?: string;
  /** Working directory for the repo-level lookup. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override home dir (tests). Defaults to `os.homedir()`. */
  home?: string;
}

export interface DiscoveredPaths {
  user?: string;
  repo?: string;
}

export function discoverConfigPaths(
  name: string,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): DiscoveredPaths {
  const rel = `.${name}-agent/config.yaml`;
  const userPath = path.join(home, rel);
  const repoPath = path.join(cwd, rel);
  const out: DiscoveredPaths = {};
  if (fs.existsSync(userPath)) out.user = userPath;
  if (fs.existsSync(repoPath)) out.repo = repoPath;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { constructor?: unknown }).constructor === Object
  );
}

/** Recursive per-key merge. Overlay wins on collision; arrays replace wholesale. */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overlay: T,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const baseV = base[k];
    if (isPlainObject(v) && isPlainObject(baseV)) {
      out[k] = deepMerge(baseV, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function readYaml(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, { encoding: "utf-8" });
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new Error(`Failed to parse YAML (${filePath}): ${msg}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Config must be a YAML mapping (${filePath}), got: ${
        Array.isArray(parsed) ? "list" : typeof parsed
      }`,
    );
  }
  return parsed;
}

function validateRule(
  field: string,
  value: unknown,
  restricted: boolean,
): Rule {
  if (typeof value !== "string" || !VALID_RULES.has(value as Rule)) {
    throw new Error(
      `${field}: expected one of [success, escalate, denied], got: ${JSON.stringify(
        value,
      )}`,
    );
  }
  const rule = value as Rule;
  if (restricted && rule === "success") {
    throw new Error(
      `${field}: 'success' is not permitted (safety floor — cannot be downgraded to success)`,
    );
  }
  return rule;
}

function validateRules(
  raw: unknown,
  floorAspects: readonly string[],
): PolicyRules {
  if (raw === undefined || raw === null) return { ...DEFAULT_POLICY };
  if (!isPlainObject(raw)) {
    throw new Error(`policy: expected an object, got: ${typeof raw}`);
  }
  const out: PolicyRules = { ...DEFAULT_POLICY };
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case "read":
        out.read = validateRule("policy.read", v, false);
        break;
      case "write":
        out.write = validateRule("policy.write", v, false);
        break;
      case "admin":
        out.admin = validateRule("policy.admin", v, true) as RestrictedRule;
        break;
      case "aspects": {
        if (!isPlainObject(v)) {
          throw new Error(
            `policy.aspects: expected an object, got: ${typeof v}`,
          );
        }
        const aspects: Record<string, Rule> = {};
        const floorSet = new Set(floorAspects);
        for (const [aspect, rule] of Object.entries(v)) {
          aspects[aspect] = validateRule(
            `policy.aspects.${aspect}`,
            rule,
            floorSet.has(aspect),
          );
        }
        out.aspects = aspects;
        break;
      }
      default:
        throw new Error(
          `policy: unknown key '${k}' (expected: read, write, admin, aspects)`,
        );
    }
  }
  return out;
}

function validateApprovalMode(raw: unknown): ApprovalMode {
  if (raw === undefined || raw === null) return "auto";
  if (typeof raw !== "string" || !VALID_APPROVAL_MODES.has(raw as ApprovalMode)) {
    throw new Error(
      `approval_mode: expected one of [auto, confirm_once, confirm_each, grant_required], got: ${JSON.stringify(
        raw,
      )}`,
    );
  }
  return raw as ApprovalMode;
}

/**
 * Top-level validator: accepts a parsed YAML mapping with optional `policy`
 * and `approval_mode` keys, returns a LoadedPolicy. Unknown top-level keys
 * pass through silently — this lets connectors add their own sections
 * (e.g., db-agent's `servers`, `audit`) without the toolkit needing to know
 * about them.
 */
export function validatePolicyConfig(
  raw: unknown,
  floorAspects: readonly string[] = [],
): LoadedPolicy {
  if (!isPlainObject(raw)) {
    throw new Error(
      `config: expected a YAML mapping at root, got: ${typeof raw}`,
    );
  }
  return {
    rules: validateRules(raw["policy"], floorAspects),
    approval_mode: validateApprovalMode(raw["approval_mode"]),
  };
}

/**
 * Discover → merge → validate. Returns `null` if no config is found and no
 * explicit path is provided; caller falls back to defaults.
 */
export function loadPolicyConfig(
  opts: LoadPolicyConfigOptions,
): LoadedPolicy | null {
  const floor = opts.floorAspects ?? [];

  if (opts.explicitPath !== undefined && opts.explicitPath.length > 0) {
    if (!fs.existsSync(opts.explicitPath)) {
      throw new Error(`Config file not found: ${opts.explicitPath}`);
    }
    return validatePolicyConfig(readYaml(opts.explicitPath), floor);
  }

  const paths = discoverConfigPaths(opts.name, opts.cwd, opts.home);
  if (paths.user === undefined && paths.repo === undefined) return null;

  let merged: Record<string, unknown> = {};
  if (paths.user !== undefined) merged = deepMerge(merged, readYaml(paths.user));
  if (paths.repo !== undefined) merged = deepMerge(merged, readYaml(paths.repo));

  return validatePolicyConfig(merged, floor);
}
