/**
 * agent_resolver — locate a connector's CLI on disk via the canonical
 * 4-step fallback every consumer (the hub, doc-wiki's wrappers, etc.) needs:
 *
 *   1. `<NAME>_AGENT_CLI` env var (operator escape hatch).
 *   2. `~/.claude/plugins/cache/<name>-agent-plugin*` — populated by Claude
 *      Code's plugin manager.
 *   3. `${CLAUDE_PLUGIN_DATA}/node_modules/<package>/<cliRelativePath>` —
 *      where the connector's `SessionStart` hook installs it.
 *   4. `~/src/connectors/<name>-agent-connector/<cliRelativePath>` — the
 *      developer-machine fallback.
 *
 * Returns null if no candidate exists, so callers can fail with a clear
 * message instead of crashing on `spawn`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolveAgentCliOptions {
  /** Connector short name (e.g. `"confluence"`, `"db"`, `"aws"`). */
  name: string;
  /** Override env-var name. Default: `<NAME>_AGENT_CLI` (uppercased + underscores for hyphens). */
  envVar?: string;
  /** Substring matched against entries in `~/.claude/plugins/cache/`. Default: `<name>-agent-plugin`. */
  pluginNameContains?: string;
  /** npm package the connector is published as. Default: `@narai/<name>-agent-connector`. */
  packageName?: string;
  /** CLI path within the package. Default: `dist/cli.js`. */
  cliRelativePath?: string;
  /** Dev-fallback root. Default: `~/src/connectors/`. */
  devRoot?: string;
  /** Override for `process.env`. Used by tests; production callers leave it alone. */
  envOverride?: NodeJS.ProcessEnv;
  /** Override for `os.homedir()`. Used by tests. */
  homeOverride?: string;
}

export type ResolutionSource =
  | "env"
  | "plugin-cache"
  | "claude-plugin-data"
  | "dev-fallback";

export interface ResolvedAgentCli {
  /** Always `"node"` — connector CLIs are always invoked through node. */
  command: string;
  /** `[absoluteCliPath]`; pass to `child_process.spawn(command, [...args, ...callerArgs])`. */
  args: string[];
  /** Which fallback path produced the resolution. Useful for diagnostics. */
  source: ResolutionSource;
  /** Absolute path that was found on disk. */
  resolvedPath: string;
}

function defaultEnvVar(name: string): string {
  return `${name.toUpperCase().replace(/-/g, "_")}_AGENT_CLI`;
}

function defaultPluginNameContains(name: string): string {
  return `${name}-agent-plugin`;
}

function defaultPackageName(name: string): string {
  return `@narai/${name}-agent-connector`;
}

function defaultDevRoot(home: string): string {
  return path.join(home, "src", "connectors");
}

export function resolveAgentCli(opts: ResolveAgentCliOptions): ResolvedAgentCli | null {
  const env = opts.envOverride ?? process.env;
  const home = opts.homeOverride ?? os.homedir();
  const envVar = opts.envVar ?? defaultEnvVar(opts.name);
  const pluginContains = opts.pluginNameContains ?? defaultPluginNameContains(opts.name);
  const packageName = opts.packageName ?? defaultPackageName(opts.name);
  const cliRelative = opts.cliRelativePath ?? "dist/cli.js";
  const devRoot = opts.devRoot ?? defaultDevRoot(home);

  // 1. Explicit env-var override.
  const envPath = env[envVar];
  if (typeof envPath === "string" && envPath !== "" && fs.existsSync(envPath)) {
    return { command: "node", args: [envPath], source: "env", resolvedPath: envPath };
  }

  // 2. Plugin cache lookup.
  const pluginCache = path.join(home, ".claude", "plugins", "cache");
  if (fs.existsSync(pluginCache)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(pluginCache);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.includes(pluginContains)) continue;
      const candidate = path.join(pluginCache, entry, "node_modules", packageName, cliRelative);
      if (fs.existsSync(candidate)) {
        return { command: "node", args: [candidate], source: "plugin-cache", resolvedPath: candidate };
      }
    }
  }

  // 3. CLAUDE_PLUGIN_DATA install location.
  const pluginData = env["CLAUDE_PLUGIN_DATA"];
  if (typeof pluginData === "string" && pluginData !== "") {
    const candidate = path.join(pluginData, "node_modules", packageName, cliRelative);
    if (fs.existsSync(candidate)) {
      return { command: "node", args: [candidate], source: "claude-plugin-data", resolvedPath: candidate };
    }
  }

  // 4. Dev fallback.
  const devCandidate = path.join(devRoot, `${opts.name}-agent-connector`, cliRelative);
  if (fs.existsSync(devCandidate)) {
    return { command: "node", args: [devCandidate], source: "dev-fallback", resolvedPath: devCandidate };
  }

  return null;
}
