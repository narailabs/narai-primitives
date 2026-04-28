/**
 * @narai/db-agent-connector — public API barrel.
 *
 * Default export: a ready-to-use `Connector` built on
 * `@narai/connector-toolkit`. Use `import connector from "narai-primitives/db"`
 * and call `connector.fetch(action, params)` / `connector.main(argv)`.
 *
 * Legacy surface: `fetch(action, params)` is re-exported from the internal
 * dispatcher for programmatic callers that want the pre-framework envelope
 * shape (`{status: "ok"|"denied"|..., rows, columns, ...}`). The framework
 * connector translates that into the canonical envelope at the boundary.
 */
import { buildDbConnector } from "./connector.js";

const connector = buildDbConnector();
export default connector;
export const { main, fetch, validActions } = connector;
export { buildDbConnector };

// Legacy dispatcher surface (pre-2.0 envelope shape, still useful for
// programmatic callers embedding the DB policy gate directly).
export {
  fetch as dispatcherFetch,
  VALID_ACTIONS,
  HELP_TEXT,
  type FetchResult,
  type FetchOptions,
  type ResolvedEnv,
} from "./dispatcher.js";

export * from "./lib/index.js";

// Selective re-export to avoid `CredentialProvider` name clash with the
// legacy class in `lib/credentials.ts`.
export {
  registerProvider,
  getProvider,
  clearProviders,
  listProviders,
  resolveSecret,
  FileProvider,
  EnvVarProvider,
  KeychainProvider,
  CloudSecretsProvider,
  parseCredentialRef,
  KNOWN_PROVIDERS,
  type ResolveSecretOptions,
  type CloudSecretsConfig,
  type CloudSubProvider,
  type CredentialRef,
} from "@narai/credential-providers";

export {
  parseConfig,
  type WikiConfig,
  ConfigFileNotFoundError,
} from "./config.js";
