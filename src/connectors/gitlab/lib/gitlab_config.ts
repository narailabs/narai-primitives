/**
 * Connector-specific runtime knobs that sit outside the toolkit's
 * policy/approval YAML. Today: `require_draft_mr` and `host`.
 *
 * - `require_draft_mr` — when true, every `create_merge_request` call is
 *   rewritten to draft mode regardless of caller input.
 * - `host` — the GitLab instance base URL (default: "https://gitlab.com").
 *
 * Precedence for host (highest wins, as merged in defaultSdk):
 *   1. resolveSecret("GITLAB_HOST") — secret provider (Vault, AWS SM, etc.)
 *   2. GITLAB_HOST env var
 *   3. <cwd>/.gitlab-agent/config.yaml `gitlab.host`
 *   4. ~/.gitlab-agent/config.yaml  `gitlab.host`
 *   5. Default https://gitlab.com (applied in GitlabClient constructor)
 *
 * loadGitlabBehavior() returns host=null when neither env nor YAML sets it,
 * allowing the caller to distinguish "explicitly configured" from "absent".
 *
 * Replicates the toolkit's discover-and-merge pattern locally so we don't
 * depend on internals of `toolkit/policy/config.ts` that aren't part of
 * its public surface.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

export interface GitlabBehavior {
  requireDraftMr: boolean;
  host: string | null;
}

export interface LoadGitlabBehaviorOptions {
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
      `gitlab config: expected a YAML mapping at root of ${filePath}, got ${
        Array.isArray(parsed) ? "list" : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

function getGitlabSection(
  configPath: string,
): Record<string, unknown> | undefined {
  const doc = readYamlFile(configPath);
  if (doc === null) return undefined;
  const section = doc["gitlab"];
  if (section === undefined) return undefined;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(
      `gitlab config: 'gitlab:' section in ${configPath} must be a mapping`,
    );
  }
  return section as Record<string, unknown>;
}

function readGitlabSectionFlag(
  configPath: string,
  key: string,
): boolean | undefined {
  const section = getGitlabSection(configPath);
  if (section === undefined) return undefined;
  const value = section[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(
      `gitlab config: 'gitlab.${key}' in ${configPath} must be a boolean, got ${typeof value}`,
    );
  }
  return value;
}

function readGitlabSectionString(
  configPath: string,
  key: string,
): string | undefined {
  const section = getGitlabSection(configPath);
  if (section === undefined) return undefined;
  const value = section[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `gitlab config: 'gitlab.${key}' in ${configPath} must be a string, got ${typeof value}`,
    );
  }
  return value;
}

function parseEnvBoolOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new Error(
    `GITLAB_REQUIRE_DRAFT_MR: expected one of 1/0/true/false/yes/no, got ${JSON.stringify(raw)}`,
  );
}

export function loadGitlabBehavior(
  opts: LoadGitlabBehaviorOptions = {},
): GitlabBehavior {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let requireDraftMr = false;
  let host: string | null = null;

  const userCfg = path.join(home, ".gitlab-agent", "config.yaml");
  const repoCfg = path.join(cwd, ".gitlab-agent", "config.yaml");

  const userDraft = readGitlabSectionFlag(userCfg, "require_draft_mr");
  if (userDraft !== undefined) requireDraftMr = userDraft;

  const userHost = readGitlabSectionString(userCfg, "host");
  if (userHost !== undefined) host = userHost;

  const repoDraft = readGitlabSectionFlag(repoCfg, "require_draft_mr");
  if (repoDraft !== undefined) requireDraftMr = repoDraft;

  const repoHost = readGitlabSectionString(repoCfg, "host");
  if (repoHost !== undefined) host = repoHost;

  const envDraft = parseEnvBoolOverride(env["GITLAB_REQUIRE_DRAFT_MR"]);
  if (envDraft !== undefined) requireDraftMr = envDraft;

  const envHost = env["GITLAB_HOST"];
  if (envHost !== undefined && envHost !== "") host = envHost;

  return { requireDraftMr, host };
}
