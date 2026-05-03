/**
 * @narai/connector-toolkit — framework for agent-connector packages.
 *
 * Primary API:
 *   - `createConnector` — build a connector from an action registry with
 *     built-in CLI harness, approval gate, audit, and hardship logging.
 *
 * Secondary helpers (shipped for advanced use and by pre-2.0 consumers):
 *   - `parseAgentArgs` — raw CLI flag parser.
 *   - `fetchWithCaps` — size/timeout-capped fetch.
 *   - `validateUrl`, `checkPathContainment`, `sanitizeLabel` — security primitives.
 *
 * Credentials live at the `narai-primitives/credentials` subpath.
 */

// ─── Primary API ───────────────────────────────────────────────────────────

export {
  EnvelopeOverride,
  createConnector,
  defineAction,
  type ActionSpec,
  type Connector,
  type ConnectorConfig,
  type Context,
  type Credentials,
  type DecisionContext,
} from "./connector.js";

// ─── Policy types / engine ─────────────────────────────────────────────────

export {
  DECISION_RANK,
  DEFAULT_POLICY,
  type ApprovalMode,
  type Classification,
  type Decision,
  type DeniedEnvelope,
  type Envelope,
  type ErrorCode,
  type ErrorEnvelope,
  type EscalateEnvelope,
  type ExtendedEnvelope,
  type Kind,
  type PolicyRules,
  type ResolutionHint,
  type RestrictedRule,
  type Rule,
  type SuccessEnvelope,
} from "./policy/types.js";

export {
  checkPolicy,
  combineDecisions,
  type ApprovalState,
} from "./policy/gate.js";

export {
  deepMerge,
  discoverConfigPaths,
  loadPolicyConfig,
  validatePolicyConfig,
  type DiscoveredPaths,
  type LoadedPolicy,
  type LoadPolicyConfigOptions,
} from "./policy/config.js";

export { ApprovalEngine } from "./policy/approval.js";

// ─── Audit ─────────────────────────────────────────────────────────────────

export {
  createAuditWriter,
  scrubSecrets,
  type AuditWriter,
  type AuditWriterOptions,
} from "./audit/writer.js";

export {
  type ActionEvent,
  type AuditEvent,
  type BaseEvent,
  type GrantEvent,
  type HardshipEvent,
  type PolicyEvent,
} from "./audit/events.js";

// ─── Hardship ──────────────────────────────────────────────────────────────

export {
  createHardshipRecorder,
  resolveHardshipPath,
  type HardshipEntry,
  type HardshipInput,
  type HardshipRecorder,
  type HardshipWriterOptions,
} from "./hardship/record.js";

export {
  countRawHardships,
  readCuratedHardships,
  readRawHardships,
  type ReadOptions,
} from "./hardship/read.js";

export {
  clusterHardships,
  entriesSinceLastCuration,
  normalizeContext,
  readCurationMarker,
  writeCurationMarker,
  type CurationMarker,
  type HardshipCluster,
} from "./hardship/curate.js";

// ─── Plugin helpers ────────────────────────────────────────────────────────

export {
  DEFAULT_PREFS,
  prefsPath,
  readPrefs,
  setEnabled,
  setSkipDays,
  writePrefs,
  type CurationPrefs,
} from "./plugin/prefs.js";

export {
  evaluateNudge,
  printNudgeIfNeeded,
  type NudgeContext,
  type NudgeDecision,
} from "./plugin/reminder.js";

export {
  buildCurateSnapshot,
  type CurateCommandOptions,
  type CurateSnapshot,
} from "./plugin/curate-cmd.js";

// ─── Legacy helpers (still exported) ───────────────────────────────────────

export {
  parseAgentArgs,
  type FlagSpec,
  type ParsedAgentArgs,
} from "./agent_cli.js";

export {
  FETCH_MAX_BYTES_DEFAULT,
  FETCH_TIMEOUT_MS_DEFAULT,
  FetchCapExceeded,
  fetchWithCaps,
  type FetchCapsOptions,
} from "./fetch_helper.js";

export {
  validateUrl,
  checkPathContainment,
  sanitizeLabel,
} from "./security_check.js";

// ─── Binary + attachment helpers (added in 2.1) ────────────────────────────

export { importOptional, isBinaryOnPath } from "./_optional.js";

export {
  extract as extractBinary,
  extractPdf,
  extractDocx,
  extractPptx,
  normalizeExtracted,
  ExtractCapExceeded,
  FORMAT_MAP,
  type BinaryFormat,
  type ExtractOptions,
  type ExtractResult,
} from "./extract_binary.js";

export {
  dispatchMultimodal,
  type MultimodalConfig,
  type MultimodalFormat,
  type MultimodalMode,
  type MultimodalResult,
} from "./extract_multimodal.js";

export {
  fetchAttachment,
  type FetchAttachmentOptions,
  type FetchAttachmentResult,
} from "./fetch_attachment.js";

// ─── Self-improvement layer (added in 3.0) ───────────────────────────────

export {
  hashScopeKey,
  resolveTierPaths,
  type Tier,
  type TierPaths,
  type TierName,
} from "./hardship/scope.js";

export {
  loadPatterns,
  matchPattern,
  type Pattern,
  type PatternsFile,
  type PatternMatcher,
  type HardshipFacts,
  type MatchedPattern,
} from "./hardship/patterns.js";

export {
  readFirstMatchingPattern,
  type ReadFirstMatchingPatternOptions,
  type TierMatch,
} from "./hardship/read.js";

export {
  renderSkillPreamble,
  type RenderSkillPreambleOptions,
} from "./hardship/preamble.js";

// ─── Usage tracking (added in 3.1) ───────────────────────────────────────

export * as usage from "./usage/index.js";

// ─── Agent CLI resolution + guardrails (added in 3.3) ────────────────────

export {
  resolveAgentCli,
  type ResolveAgentCliOptions,
  type ResolvedAgentCli,
  type ResolutionSource,
} from "./agent_resolver.js";

export {
  loadGuardrailManifest,
  findBlockingRule,
  defaultDenyMessage,
  type GuardrailRule,
  type GuardrailManifest,
  type BlockMatch,
} from "./guardrail.js";
