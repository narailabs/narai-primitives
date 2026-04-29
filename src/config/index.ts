/**
 * Public API for `@narai/connector-config`.
 *
 * Consumers (the hub, every standalone connector) typically need just
 * `loadResolvedConfig`. The lower-level `resolveConfig` + file loaders are
 * exported for tests and advanced use.
 */

export {
  loadResolvedConfig,
  loadBaseConfig,
  loadFile,
  deepMerge,
  userConfigPath,
  repoConfigPath,
} from "./load.js";

export { resolveConfig, resolveConnector } from "./resolve.js";

export {
  assertValidSecretSyntax,
  validateSecretsInTree,
} from "./secrets.js";

export {
  validatePolicies,
  assertValidPolicies,
  type PolicyIssue,
  type ValidationOptions,
} from "./policy_validation.js";

export {
  loadConnectorEnvironment,
  type LoadConnectorEnvironmentOptions,
} from "./bootstrap.js";

export type {
  PolicyAction,
  PolicyDecision,
  PolicyMap,
  RawConfigInput,
  LoadOptions,
  ResolveOptions,
  ResolvedConfig,
  ResolvedConnector,
} from "./types.js";
