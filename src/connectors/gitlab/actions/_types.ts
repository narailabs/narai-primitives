/**
 * Shared types used by every GitLab action-module factory.
 */
import type { ActionSpec } from "narai-primitives/toolkit";
import type { GitlabBehavior } from "../lib/gitlab_config.js";
import type { GitlabClient } from "../lib/gitlab_client.js";

export type GitlabActions = Record<string, ActionSpec<any, GitlabClient>>;

export interface GitlabActionDeps {
  /** Runtime knobs (require_draft_mr, host, ...). */
  behavior: GitlabBehavior;
}
