/**
 * scope.ts — tenant-scope hashing + 4-tier path resolution for the
 * self-improvement loop.
 *
 * Paths:
 *   tier 1 (most specific):  <cwd>/.claude/connectors/<conn>/tenants/<hash>/
 *   tier 2:                  <cwd>/.claude/connectors/<conn>/global/
 *   tier 3:                  <home>/.claude/connectors/<conn>/tenants/<hash>/
 *   tier 4 (least specific): <home>/.claude/connectors/<conn>/global/
 *
 * Match walks tier 1 → 4 returning the first hit. Write goes to the
 * most specific tier that "exists" (has <cwd>/.claude/).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

export type TierName =
  | "project-tenant"
  | "project-global"
  | "user-tenant"
  | "user-global";

export interface Tier {
  name: TierName;
  dir: string;
  scopeLevel: "tenant" | "global";
}

export type TierPaths = Tier[];

/**
 * 16-char hex sha256 prefix. Stable across processes, short enough for
 * filesystem paths, collision probability negligible for O(100) tenants.
 */
export function hashScopeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export interface ResolveTierPathsOptions {
  connector: string;
  scope: string | null;
  cwd: string;
  home: string;
}

export function resolveTierPaths(opts: ResolveTierPathsOptions): TierPaths {
  const { connector, scope, cwd, home } = opts;
  const tiers: Tier[] = [];
  const projectRoot = path.join(cwd, ".claude/connectors", connector);
  const userRoot = path.join(home, ".claude/connectors", connector);

  if (scope !== null) {
    const hash = hashScopeKey(scope);
    tiers.push({
      name: "project-tenant",
      dir: path.join(projectRoot, "tenants", hash),
      scopeLevel: "tenant",
    });
  }
  tiers.push({
    name: "project-global",
    dir: path.join(projectRoot, "global"),
    scopeLevel: "global",
  });
  if (scope !== null) {
    const hash = hashScopeKey(scope);
    tiers.push({
      name: "user-tenant",
      dir: path.join(userRoot, "tenants", hash),
      scopeLevel: "tenant",
    });
  }
  tiers.push({
    name: "user-global",
    dir: path.join(userRoot, "global"),
    scopeLevel: "global",
  });
  return tiers;
}
