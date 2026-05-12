/**
 * Connector-specific runtime knobs that sit outside the toolkit's
 * policy/approval YAML. Today: `require_draft_pr` — when true, every
 * `create_pull_request` call is rewritten to `draft: true` regardless of
 * caller input.
 *
 * Precedence (highest wins):
 *   1. GITHUB_REQUIRE_DRAFT_PR env var
 *   2. <cwd>/.github-agent/config.yaml `github.require_draft_pr`
 *   3. ~/.github-agent/config.yaml  `github.require_draft_pr`
 *   4. default: false
 *
 * Replicates the toolkit's discover-and-merge pattern locally (~25
 * lines) so we don't depend on internals of `toolkit/policy/config.ts`
 * that aren't part of its public surface.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

export interface GithubBehavior {
  requireDraftPr: boolean;
}

export interface LoadGithubBehaviorOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const TRUTHY = new Set(["1", "true", "yes"]);
const FALSY = new Set(["0", "false", "no"]);

function readYamlFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `github config: expected a YAML mapping at root of ${filePath}, got ${
        Array.isArray(parsed) ? "list" : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

function readGithubSectionFlag(
  configPath: string,
  key: string,
): boolean | undefined {
  const doc = readYamlFile(configPath);
  if (doc === null) return undefined;
  const section = doc["github"];
  if (section === undefined) return undefined;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(
      `github config: 'github:' section in ${configPath} must be a mapping`,
    );
  }
  const value = (section as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(
      `github config: 'github.${key}' in ${configPath} must be a boolean, got ${typeof value}`,
    );
  }
  return value;
}

function parseEnvOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new Error(
    `GITHUB_REQUIRE_DRAFT_PR: expected one of 1/0/true/false/yes/no, got ${JSON.stringify(raw)}`,
  );
}

export function loadGithubBehavior(
  opts: LoadGithubBehaviorOptions = {},
): GithubBehavior {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let requireDraftPr = false;

  const userVal = readGithubSectionFlag(
    path.join(home, ".github-agent", "config.yaml"),
    "require_draft_pr",
  );
  if (userVal !== undefined) requireDraftPr = userVal;

  const repoVal = readGithubSectionFlag(
    path.join(cwd, ".github-agent", "config.yaml"),
    "require_draft_pr",
  );
  if (repoVal !== undefined) requireDraftPr = repoVal;

  const envVal = parseEnvOverride(env["GITHUB_REQUIRE_DRAFT_PR"]);
  if (envVal !== undefined) requireDraftPr = envVal;

  return { requireDraftPr };
}
