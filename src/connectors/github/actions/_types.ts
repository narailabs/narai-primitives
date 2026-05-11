/**
 * Shared types used by every action-module factory. Each module exports a
 * factory `buildXActions(deps)` returning an action registry. Keeping the
 * dep shape in one place avoids drift across the six modules.
 */
import type { ActionSpec } from "narai-primitives/toolkit";
import type { GithubBehavior } from "../lib/github_config.js";
import type { GithubClient } from "../lib/github_client.js";

export type GithubActions = Record<string, ActionSpec<any, GithubClient>>;

export interface GithubActionDeps {
  /** Runtime knobs (require_draft_pr, ...). */
  behavior: GithubBehavior;
}
