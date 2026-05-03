/**
 * agent_resolver — locate a connector's CLI on disk via the canonical
 * 5-step fallback every consumer (the hub, doc-wiki's wrappers, etc.) needs:
 *
 *   1. `<NAME>_AGENT_CLI` env var (operator escape hatch).
 *   2. **Bundled-self** — when narai-primitives is installed (npm install,
 *      npm link, or running from its own source tree), the canonical 2.x
 *      layout ships every connector CLI at
 *      `<narai-primitives root>/dist/connectors/<name>/cli.js`. The
 *      resolver derives that root from its own file path via
 *      `import.meta.url`, so the lookup works regardless of install layout.
 *   3. `~/.claude/plugins/cache/<name>-agent-plugin*` — populated by Claude
 *      Code's plugin manager.
 *   4. `${CLAUDE_PLUGIN_DATA}/node_modules/<package>/<cliRelativePath>` —
 *      where the connector's `SessionStart` hook installs it.
 *   5. `~/src/connectors/<name>-agent-connector/<cliRelativePath>` — the
 *      legacy developer-machine fallback (kept for backward compat with
 *      pre-2.0 layouts).
 *
 * Returns null if no candidate exists, so callers can fail with a clear
 * message instead of crashing on `spawn`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  /**
   * Override the bundled-self search root. The default is computed from
   * `import.meta.url` (the resolver's own file location) so the lookup
   * works in any install layout. Pass `null` (explicit) to skip the
   * bundled-self check entirely — useful for unit tests that want to
   * exercise the lower fallback paths without colliding with the real
   * bundled connector CLIs that ship next to this file.
   */
  bundledSelfRoot?: string | null;
  /** Override for `process.env`. Used by tests; production callers leave it alone. */
  envOverride?: NodeJS.ProcessEnv;
  /** Override for `os.homedir()`. Used by tests. */
  homeOverride?: string;
}

export type ResolutionSource =
  | "env"
  | "bundled-self"
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

/**
 * Derive narai-primitives' own package root from this file's location.
 *
 * Layout after build: `<package root>/dist/toolkit/agent_resolver.js`. Walking
 * up two directories from `import.meta.url` lands on the package root in
 * every install scenario (npm install, npm link, source dir).
 *
 * Returns `null` when the file URL can't be parsed — defensive only;
 * shouldn't happen in any standard ESM runtime.
 */
function defaultBundledSelfRoot(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(here), "..", "..");
  } catch {
    return null;
  }
}

export function resolveAgentCli(opts: ResolveAgentCliOptions): ResolvedAgentCli | null {
  const env = opts.envOverride ?? process.env;
  const home = opts.homeOverride ?? os.homedir();
  const envVar = opts.envVar ?? defaultEnvVar(opts.name);
  const pluginContains = opts.pluginNameContains ?? defaultPluginNameContains(opts.name);
  const packageName = opts.packageName ?? defaultPackageName(opts.name);
  const cliRelative = opts.cliRelativePath ?? "dist/cli.js";
  const devRoot = opts.devRoot ?? defaultDevRoot(home);
  const bundledSelfRoot =
    opts.bundledSelfRoot === null
      ? null
      : (opts.bundledSelfRoot ?? defaultBundledSelfRoot());

  // 1. Explicit env-var override.
  const envPath = env[envVar];
  if (typeof envPath === "string" && envPath !== "" && fs.existsSync(envPath)) {
    return { command: "node", args: [envPath], source: "env", resolvedPath: envPath };
  }

  // 2. Bundled-self: the canonical 2.x layout ships every connector CLI at
  //    `<narai-primitives root>/dist/connectors/<name>/cli.js`. This is the
  //    primary path for any caller that has narai-primitives installed —
  //    npm install, npm link, or a source checkout all flow through here.
  if (bundledSelfRoot !== null) {
    const bundledCli = path.join(
      bundledSelfRoot,
      "dist",
      "connectors",
      opts.name,
      "cli.js",
    );
    if (fs.existsSync(bundledCli)) {
      return {
        command: "node",
        args: [bundledCli],
        source: "bundled-self",
        resolvedPath: bundledCli,
      };
    }
  }

  // 3. Plugin cache lookup.
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

  // 4. CLAUDE_PLUGIN_DATA install location.
  const pluginData = env["CLAUDE_PLUGIN_DATA"];
  if (typeof pluginData === "string" && pluginData !== "") {
    const candidate = path.join(pluginData, "node_modules", packageName, cliRelative);
    if (fs.existsSync(candidate)) {
      return { command: "node", args: [candidate], source: "claude-plugin-data", resolvedPath: candidate };
    }
  }

  // 5. Dev fallback (legacy ~/src/connectors/<name>-agent-connector layout).
  const devCandidate = path.join(devRoot, `${opts.name}-agent-connector`, cliRelative);
  if (fs.existsSync(devCandidate)) {
    return { command: "node", args: [devCandidate], source: "dev-fallback", resolvedPath: devCandidate };
  }

  return null;
}
