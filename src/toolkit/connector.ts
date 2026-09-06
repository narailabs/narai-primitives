/**
 * `createConnector` — the common framework factory.
 *
 * Each connector's package declares a config (name, credentials loader,
 * optional SDK loader, action registry, hooks). The factory returns
 * `{main, fetch, validActions, name}`:
 *
 *   - `main(argv)` parses `--action`/`--params`/`--curate`/`--help`,
 *     dispatches to `fetch`, emits the envelope on stdout, returns an
 *     exit code.
 *   - `fetch(action, params)` is the library surface — validates Zod,
 *     classifies, runs the policy gate, loads sdk/credentials lazily
 *     on success, runs the handler, wraps exceptions in error envelopes.
 *
 * Every step emits audit events and writes hardship entries where
 * appropriate.
 */
import type { ZodSchema } from "zod";
import { z } from "zod";
import { parseAgentArgs } from "./agent_cli.js";
import {
  createAuditWriter,
  isCredentialContainerPath,
  isSensitiveFieldPath,
  mentionsSensitiveField,
  scrubSecrets,
  type AuditWriter,
} from "./audit/writer.js";
import { readFirstMatchingPattern } from "./hardship/read.js";
import {
  createHardshipRecorder,
  type HardshipRecorder,
} from "./hardship/record.js";
import { buildCurateSnapshot } from "./plugin/curate-cmd.js";
import { ApprovalEngine } from "./policy/approval.js";
import { loadPolicyConfig, type LoadedPolicy } from "./policy/config.js";
import { checkPolicy } from "./policy/gate.js";
import {
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
  type PolicyRules,
  type SuccessEnvelope,
} from "./policy/types.js";

// ───────────────────────────────────────────────────────────────────────────
// Public API types
// ───────────────────────────────────────────────────────────────────────────

export interface Context<TSdk> {
  sdk: TSdk;
  credentials: Credentials;
  policy: Decision;
  recordHardship: HardshipRecorder;
  logger: { debug(msg: string): void; warn(msg: string): void };
}

export interface ActionSpec<TParams = any, TSdk = unknown> {
  params: ZodSchema<TParams>;
  classify: Classification | ((p: TParams) => Classification);
  handler: (p: TParams, ctx: Context<TSdk>) => Promise<unknown>;
  description?: string;
}

/**
 * Helper for writing a single action spec with full param-type inference.
 * TypeScript can't thread `z.infer<S>` through the `actions` record on its
 * own, so wrapping each spec in `defineAction` gives the handler's `p` the
 * exact schema-inferred type without manual annotations.
 *
 * Usage:
 *   actions: {
 *     list_functions: defineAction({
 *       params: z.object({ region: z.string() }),
 *       classify: { kind: "read" },
 *       handler: async (p, ctx) => ctx.sdk.lambda.list(p),
 *     }),
 *   },
 */
export function defineAction<S extends ZodSchema, TSdk = unknown>(spec: {
  params: S;
  classify: Classification | ((p: z.infer<S>) => Classification);
  handler: (p: z.infer<S>, ctx: Context<TSdk>) => Promise<unknown>;
  description?: string;
}): ActionSpec<z.infer<S>, TSdk> {
  return spec;
}

export type Credentials = Record<string, unknown>;

export interface DecisionContext {
  action: string;
  params: unknown;
  classification: Classification;
}

/**
 * Escape hatch for handlers that need to emit a non-success envelope the
 * base framework doesn't model directly. Throw this from a handler with
 * the exact envelope shape you want returned — the framework will add the
 * `action` field and emit it verbatim.
 *
 * Typical use: `db-agent-connector` throws this for `denied` / `escalate` /
 * `present_only` results coming back from its internal policy gate, since
 * those are shaped with additional fields (`reason`, `formatted_sql`,
 * `execution_time_ms`) that ErrorEnvelope can't carry.
 *
 * Prefer the `classify` hook + `extendDecision` for policy-gate-driven
 * envelopes whenever possible — this escape hatch is for cases where the
 * status decision can only be made after running the handler.
 */
export class EnvelopeOverride extends Error {
  readonly envelope: Omit<ExtendedEnvelope, "action"> &
    Partial<Pick<ExtendedEnvelope, "action">>;
  constructor(
    envelope: Omit<ExtendedEnvelope, "action"> &
      Partial<Pick<ExtendedEnvelope, "action">>,
  ) {
    super(`EnvelopeOverride: ${envelope.status}`);
    this.name = "EnvelopeOverride";
    this.envelope = envelope;
  }
}

export interface ConnectorConfig<TSdk = unknown> {
  name: string;
  version?: string;
  credentials: () => Promise<Credentials>;
  sdk?: () => Promise<TSdk>;
  /** Action registry, keyed by action name. */
  actions: Record<string, ActionSpec<any, TSdk>>;

  // Optional hooks ───────────────────────────────────────────────────────────
  /** Override per-action classification (e.g. db-agent classifies based on SQL). */
  classify?: (
    action: string,
    params: unknown,
  ) => Classification | Promise<Classification>;
  /** Extend the Decision before it becomes an envelope (e.g. attach formatted_sql). */
  extendDecision?: (
    decision: Decision,
    ctx: DecisionContext,
  ) => Decision | ExtendedEnvelope;
  /** Map a caught exception to a custom error envelope. Return `undefined` to fall through. */
  mapError?: (
    err: unknown,
    action: string,
  ) => Partial<ErrorEnvelope> | undefined;

  // Optional config ──────────────────────────────────────────────────────────
  policyConfigPath?: string;
  /** Aspects that cannot be downgraded to `"success"` in operator config. */
  policyFloorAspects?: readonly string[];
  /**
   * Decision strings this connector recognizes beyond the universal
   * `PolicyDecision` set (`"allow" | "escalate" | "deny"`). Declaring this
   * is the runtime complement to specializing `PolicyMap<TExtra>` at the
   * type level: the hub may use it to validate operator-supplied
   * `~/.connectors/config.yaml` values, and tooling can introspect a
   * connector's policy vocabulary without parsing its source. Example:
   * db-agent declares `policyExtras: ["present"] as const` to register
   * its `"present"` rule.
   */
  readonly policyExtras?: readonly string[];
  /** Default rules when no config is found. Defaults to `DEFAULT_POLICY`. */
  defaultPolicy?: PolicyRules;
  /**
   * Skip the toolkit's YAML discovery entirely. Use this when the connector
   * owns a different config format (e.g. `db-agent-connector`'s
   * `.db-agent/config.yaml` has legacy labels + `servers:` that the toolkit's
   * validator rejects). The handler is responsible for gating calls itself.
   */
  disablePolicyDiscovery?: boolean;
  audit?: { enabled: boolean; path?: string };
  hardship?: {
    enabled?: boolean;
    recorder?: HardshipRecorder;
  };
  /** Derive a per-request tenant scope key from the resolved SDK. Used to tag hardship entries. */
  scope?: (ctx: {
    sdk: TSdk;
    action: string;
    params: unknown;
  }) => string | null;
  /** Path overrides for test isolation — forwarded to readFirstMatchingPattern. */
  runtime?: {
    cwd?: string;
    home?: string;
  };
}

export interface Connector {
  main(argv: readonly string[]): Promise<number>;
  fetch(action: string, params: unknown): Promise<Envelope>;
  readonly validActions: ReadonlySet<string>;
  readonly name: string;
  recordResolution(input: {
    pattern_id: string;
    advice: string;
    action?: string;
    scope?: string | null;
  }): void;
}

// ───────────────────────────────────────────────────────────────────────────
// Error-code mapping defaults
// ───────────────────────────────────────────────────────────────────────────

const RETRIABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "CONNECTION_ERROR",
]);

function isZodErrorLike(
  err: unknown,
): err is {
  name: string;
  issues: Array<{ path: unknown[]; message: string; code?: unknown }>;
} {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e["name"] === "ZodError" &&
    Array.isArray(e["issues"]) &&
    e["issues"].every((i) => {
      if (!i || typeof i !== "object") return false;
      const issue = i as Record<string, unknown>;
      return (
        Array.isArray(issue["path"]) && typeof issue["message"] === "string"
      );
    })
  );
}

/**
 * Below this length, an echoed input is redacted only where it stands as a
 * whole token, not as a substring.
 *
 * This number was a cutoff that EXCLUDED short values, and review was right
 * that excluding them leaks: a one-character credential is still a
 * credential. But including them under the same substring rule is worse than
 * the leak — with `{ name: "a" }` in params, redacting every "a" turns
 * `Invalid parameter` into `Inv[REDACTED]lid p[REDACTED]r[REDACTED]meter` and
 * destroys every diagnostic in the connector.
 *
 * Both failures come from one substring test doing two jobs. A long value is
 * unambiguous wherever it occurs; a short one is only meaningful when it is
 * the whole word. So the length now selects the MATCHING RULE rather than
 * deciding inclusion, and nothing is excluded. `rejected value x` still
 * redacts, `Invalid parameter` still reads.
 */
const WHOLE_TOKEN_MATCH_BELOW_LEN = 3;

/**
 * Bound on nodes visited while collecting input strings. Params are caller
 * supplied, so a pathological structure must cost bounded time.
 */
const MAX_INPUT_NODES = 50_000;

/**
 * Bound on (issue x candidate) comparisons while formatting a validation
 * error. Generous enough that no honest schema reaches it — the schemas here
 * emit a handful of issues — and low enough that a caller cannot buy
 * `MAX_INPUT_NODES` squared work on a synchronous error path.
 */
const MAX_REDACTION_COMPARISONS = 200_000;

/**
 * The unit a comparison is CHARGED in, in characters.
 *
 * The counter above bounds how many comparisons happen, not how much they
 * read, and each one is an `includes`/`replace` over the WHOLE message. So the
 * ceiling admitted an unbounded amount of synchronous scanning on an error
 * path: measured, 2000 candidates against a 2 MB message cost 95 ms on the
 * `includes` branch and 2187 ms on the short-value regex branch — and that is
 * 2000 of a permitted 200 000.
 *
 * Charging `ceil(message.length / 1KB)` units per candidate makes the existing
 * budget measure work instead of calls, without inventing a second tuned
 * number: a 1 KB message still costs one unit per candidate, exactly as
 * before, and a 2 MB message costs 2000, so it exhausts the budget after 100
 * candidates rather than 200 000.
 *
 * The check also runs BEFORE the loop. Accumulating during it lets a single
 * enormous message through for one full pass before the first charge is
 * levied, which is most of the cost when the candidate list is short.
 */
const REDACTION_CHARGE_UNIT = 1024;

/**
 * Add a redaction candidate, plus the normalizations a schema is likely to
 * have applied before the message was written.
 *
 * The empty string is refused. It cannot expose anything, and in the
 * whole-token branch it compiles to a zero-length pattern that matches at
 * every boundary — one `""` in params turned `Invalid option: use --filter.`
 * into `Invalid option:[REDACTED] use [REDACTED]-[REDACTED]-filter.`, which
 * corrupts every diagnostic the connector emits.
 *
 * The normalizations exist because a `superRefine` runs on the value AFTER any
 * `transform` in the chain, so the string it names is not always the string in
 * `params`: `z.string().transform((v) => v.trim())` given `"  hunter2  "`
 * reports `rejected value hunter2`, which matched nothing. Trim and case cover
 * the transforms schemas here actually use. See the limits noted on
 * `collectInputStrings` — an arbitrary transform is still not derivable.
 */
function addCandidate(out: Set<string>, value: string): void {
  if (value === "") return;
  out.add(value);
  const trimmed = value.trim();
  if (trimmed !== "" && trimmed !== value) out.add(trimmed);
  for (const variant of [trimmed.toLowerCase(), trimmed.toUpperCase()]) {
    if (variant !== "" && variant !== value) out.add(variant);
  }
}

/**
 * Every string appearing as a value anywhere in the action's params.
 *
 * This is the signal that actually distinguishes a dangerous issue message
 * from a safe one: a message is a leak exactly when it echoes what the caller
 * passed in. Keying off the issue `code` instead was a proxy, and it was wrong
 * in both directions — it missed a `custom` issue raised at a nested path, and
 * it blanked constant `.refine` diagnostics that never touch the input.
 *
 * Cycle-guarded rather than depth-limited. The depth cap this replaced was a
 * proxy for "do not loop forever on a cyclic object", and it paid for that with
 * silence: a credential nested deeper than the cap simply never entered the
 * set, and nothing downstream could tell that from "there was no credential".
 * A `seen` set stops a cycle for the reason the cap was guessing at, and lets
 * every reachable value be collected.
 *
 * Traversal is an explicit stack, not recursion. The node bound limits total
 * work but not nesting, and the two are independent: a few thousand nested
 * arrays exhaust the JavaScript call stack long before 50k nodes are visited,
 * which turned an ordinary validation failure into a `RangeError` escaping as
 * a crash instead of an error envelope. Depth now costs heap, which the same
 * bound already covers.
 *
 * Returns whether the walk COMPLETED. Hitting the bound means the set is
 * partial, and a partial set is indistinguishable from a complete one to
 * every caller — which is precisely the silence the depth cap was removed for.
 * The caller fails closed on `false` rather than redacting against a set that
 * may be missing the credential.
 */
/**
 * Own enumerable DATA properties of a plain object, or `null` when the walk
 * cannot safely enumerate it. `null` means an incomplete walk, which both
 * collectors' callers already fail closed on.
 *
 * Two distinct fail-open holes, closed in one place so the two collectors
 * cannot drift — they hold the same rule and drifting copies of one rule is
 * exactly the defect narailabs/narai-primitives#210 exists to repair in the db
 * copy of the scrubber.
 *
 * **Unsupported containers.** `Object.entries`/`Object.values` return `[]` for
 * a `Map` or a `Set`, so a credential inside one produced a COMPLETE walk with
 * no candidates: a silent empty result from the function whose entire job is
 * to decide what to redact. `{ token: { k: "hunter2" } }` redacted and
 * `{ token: new Map([["k", "hunter2"]]) }` leaked, on the same sensitive path.
 * The tag test is blunt on purpose — it also excludes `Date`, `RegExp`,
 * class instances and anything else exotic — because teaching this walker
 * every collection type is a losing game, and the cost of being wrong here is
 * a leaked credential rather than a lost message.
 *
 * **Accessors.** Reading a property runs caller code. An earlier round caught
 * a getter that THREW; the `catch` does nothing for one that blocks, and a
 * getter that never returns means `fetch()` never resolves at all — strictly
 * worse than the exception, because there is no error to report. Descriptors
 * are inspected instead of values, and any accessor makes the walk incomplete.
 * This narrows the hole rather than closing it: `getOwnPropertyDescriptors`
 * still fires a Proxy's traps.
 */
/**
 * One array element, or `null` when reading it is not safe.
 *
 * Indexed reads run caller code exactly as property reads do — an accessor
 * installed at index 0 is invoked by `cur[i]` — so the accessor rule the
 * object branch enforces has to hold here too, or the guard is only half
 * present. Both walkers go through this for the same reason they share
 * {@link enumerableDataEntries}.
 */
function arrayElementValue(
  arr: readonly unknown[],
  i: number,
): { value: unknown } | null {
  let d: PropertyDescriptor | undefined;
  try {
    d = Object.getOwnPropertyDescriptor(arr, i);
  } catch {
    return null;
  }
  if (d === undefined) return { value: undefined };
  if (d.get !== undefined || d.set !== undefined) return null;
  return { value: d.value };
}

function enumerableDataEntries(
  v: object,
  budget: number,
): Array<[string, unknown]> | null {
  try {
    // Inside the try. `Object.prototype.toString` reads a caller-defined
    // `Symbol.toStringTag`, which can be a getter and can throw — so the
    // plain-object test added to close the container hole was itself an
    // uncaught call to caller code, on the same path and with the same
    // consequence: `fetch()` rejecting instead of returning the envelope.
    // The PROTOTYPE, not the tag. `Object.prototype.toString.call(new Foo())`
    // is `[object Object]` for an ordinary class instance, so the tag test
    // written to exclude class instances did not exclude them — a credential
    // in a private field behind a prototype getter enumerated to nothing and
    // reported a COMPLETE walk, which is the fail-open this check exists to
    // prevent. A plain object literal and a null-prototype object pass; a
    // class instance, a Map, a Set, a Date and a RegExp do not.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null;
    // Width before descriptors. `getOwnPropertyDescriptors` materializes one
    // descriptor object per property, so a programmatic object with millions
    // of keys bought seconds of synchronous work and the memory for all of it
    // before `MAX_INPUT_NODES` was ever consulted. `Object.keys` allocates
    // one array of names, which is the cheapest way to learn the width, and
    // the walk fails closed past its remaining budget.
    if (Object.keys(v).length > budget) return null;
    const descs = Object.getOwnPropertyDescriptors(v);
    const entries: Array<[string, unknown]> = [];
    for (const k of Object.keys(descs)) {
      const d = descs[k];
      if (d === undefined || !d.enumerable) continue;
      if (d.get !== undefined || d.set !== undefined) return null;
      entries.push([k, d.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function collectInputStrings(input: unknown, out: Set<string>): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [input];
  let nodes = 0;
  while (stack.length > 0) {
    if (nodes++ > MAX_INPUT_NODES) return false;
    const cur = stack.pop();
    if (typeof cur === "string") {
      addCandidate(out, cur);
      continue;
    }
    // Non-string primitives count too. A message interpolating them renders
    // their string form, so that is what has to be matched — and a credential
    // is not always a string. A numeric PIN (`{ password: 123456 }`) was
    // outside this defence entirely: the path need not be sensitive, and
    // `scrubSecrets` has no `key = value` shape to find in `rejected value
    // 123456`.
    if (typeof cur === "number" || typeof cur === "bigint") {
      addCandidate(out, String(cur));
      continue;
    }
    if (cur === null || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    // Budget the ENQUEUE, not just the pop. Checking only on the way out let
    // a container push its whole contents first, so `new Array(1_000_000_000)`
    // — cheap to construct, and reachable through a programmatic `fetch()` —
    // grew the work stack to a billion entries before the bound was consulted
    // again. Time was never the tell: 8M slots cost 68ms and 311MB, so the
    // process died of memory while looking fast. The bound now holds for both.
    // Indexed, not `for…of`: the iteration protocol reads and calls
    // `cur[Symbol.iterator]`, which is caller code on an array subclass and is
    // the same escape the object branch below was closed for. `length` is an
    // own non-configurable property of an array, so only element reads can
    // throw, and those are an incomplete walk — which the caller fails closed
    // on for exactly this reason.
    if (Array.isArray(cur)) {
      try {
        const len = cur.length;
        for (let i = 0; i < len; i++) {
          if (nodes++ > MAX_INPUT_NODES) return false;
          const el = arrayElementValue(cur, i);
          if (el === null) return false;
          stack.push(el.value);
        }
      } catch {
        return false;
      }
      continue;
    }
    // Reading a property can run caller code. An enumerable getter that
    // throws turned this walk into the thing that broke `fetch()`'s contract:
    // the schema had already produced an ordinary validation failure, and the
    // exception from collecting redaction candidates escaped in place of the
    // envelope the caller was promised. Treated as an incomplete walk, which
    // the caller already fails closed on — the reason the traversal exists is
    // to decide what to redact, and a traversal that did not finish cannot.
    const dataEntries = enumerableDataEntries(cur, MAX_INPUT_NODES - nodes);
    if (dataEntries === null) return false;
    for (const [, v] of dataEntries) {
      if (nodes++ > MAX_INPUT_NODES) return false;
      stack.push(v);
    }
  }
  return true;
}

/** Escape a literal for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace occurrences of caller-supplied values in a message.
 *
 * Redacting the occurrences, rather than dropping the message that contains
 * one, keeps every word the author wrote that is not the caller's own input:
 * `rejected value xy` becomes `rejected value [REDACTED]` and a constant
 * `.refine` instruction survives with only the echoed token removed. Dropping
 * on echo was wrong in kind, not degree — it blanked a diagnostic whenever an
 * input string happened to occur inside it, while a value below the length
 * cutoff still escaped entirely: opposite failures of one substring test used
 * as a boolean.
 *
 * Longest first — a short value can be a substring of a longer one, and
 * replacing the short one first would leave the longer one's remainder
 * standing.
 *
 * The node bound limits the WALK, not the formatting that follows it, and the
 * two are independent in the same way depth and node count were. One issue per
 * rejected array element against one candidate per element is a cross-product:
 * 8k elements measured 134ms against 35ms for 4k, which is the quadratic
 * signature, and the ceiling is the node bound squared. Budgeting the
 * comparisons makes the existing bound actually bound the error path;
 * exhausting the budget fails closed, like a partial walk. The budget is
 * shared across every message one redactor formats, which is why it is held
 * here rather than passed per call.
 *
 * Module-level, and used by BOTH error paths. It was a closure inside the Zod
 * branch, and the runtime path had no equivalent at all — the divergence that
 * this connector's own db sibling spent a separate PR repairing.
 */
function makeEchoRedactor(candidates: Iterable<string>): {
  redact: (message: string) => string;
  exhausted: () => boolean;
} {
  const byLengthDesc = [...candidates].sort((a, b) => b.length - a.length);
  let comparisons = 0;
  let budgetExhausted = false;
  return {
    exhausted: (): boolean => budgetExhausted,
    redact: (message: string): string => {
      // Charge the scan, not the call: a miss costs a full pass over the
      // message. Checked here as well as in the loop, because accumulating
      // only inside it lets one enormous message buy a complete pass before
      // the first charge is levied.
      const charge = Math.max(
        1,
        Math.ceil(message.length / REDACTION_CHARGE_UNIT),
      );
      if (charge * byLengthDesc.length > MAX_REDACTION_COMPARISONS) {
        budgetExhausted = true;
        return "[REDACTED]";
      }
      let out = message;
      for (const value of byLengthDesc) {
        comparisons += charge;
        if (comparisons > MAX_REDACTION_COMPARISONS) {
          budgetExhausted = true;
          return "[REDACTED]";
        }
        if (value.length >= WHOLE_TOKEN_MATCH_BELOW_LEN) {
          if (out.includes(value)) out = out.split(value).join("[REDACTED]");
          continue;
        }
        // A short value only counts where it is the whole token. Anchored on
        // non-word neighbours rather than `\b`, so a punctuation-only value
        // (`-`, `.`) — which `\b` cannot anchor at all — is still matched.
        //
        // The left boundary is a LOOKBEHIND, not a consuming group. Consuming
        // it meant one match ate the character the next match needed to start
        // from, so consecutive occurrences of a punctuation-only value were
        // half-redacted: candidate `.` turned `rejected ..` into `rejected
        // [REDACTED].`, and `--` turned `----` into `[REDACTED]--`, leaving a
        // complete credential standing. Only punctuation values reach this:
        // an alphanumeric one cannot neighbour itself and still be a whole
        // token. Both boundaries are now non-consuming and symmetric.
        const re = new RegExp(
          `(?<![A-Za-z0-9_])${escapeRegExp(value)}(?=[^A-Za-z0-9_]|$)`,
          "g",
        );
        out = out.replace(re, () => "[REDACTED]");
      }
      return out;
    },
  };
}

/**
 * Values the caller passed at a SENSITIVE parameter path.
 *
 * The runtime error path — a handler or a `mapError` throwing — was guarded by
 * `scrubSecrets` alone, which recognises shapes: `key=value`, an Authorization
 * header, a URL with userinfo. A handler that echoes a credential as ordinary
 * prose has none of those, so `{ token: "hunter2" }` with a handler throwing
 * `upstream rejected hunter2` wrote the token to the stdout envelope and into
 * hardship context intact.
 *
 * Path-scoped, unlike {@link collectInputStrings}, and that is the whole
 * design. The Zod path can redact against EVERY input value because a
 * validation message echoes the value it rejected. A runtime message echoes
 * whatever the author interpolated, and most of that is legitimately
 * diagnostic: `{ table: "users" }` with `no such table: users` must keep the
 * table name, or the error stops being an error report. Only values the schema
 * itself marks as credentials are candidates.
 *
 * Same bounds and the same failure modes as {@link collectInputStrings}: node
 * budget, cycle guard, indexed array walk, and accessors that throw are an
 * incomplete walk rather than an escaped exception. Returns whether the walk
 * COMPLETED, so the caller can fail closed on a partial set.
 */
function collectSensitiveInputStrings(input: unknown, out: Set<string>): boolean {
  // Keyed on the object AND on whether it was reached sensitively, not on the
  // object alone. One object can be reachable by two paths — a passthrough
  // schema with `{token: shared, metadata: shared}` is the plain case — and a
  // plain `Set` made the answer depend on property order: the LIFO walk
  // reached `shared` through `metadata` first, marked it seen, collected
  // nothing, and then skipped the `token` alias entirely. `false` means it was
  // seen only through a benign path, so a later sensitive alias must revisit.
  // A node is therefore visited at most twice, which keeps the budget's shape.
  const seen = new Map<object, boolean>();
  // No dotted path is carried. Sensitivity is INHERITED, and both predicates
  // are anchored on segment boundaries, so testing the new segment is
  // equivalent to testing the whole ancestry — an ancestor that made the
  // subtree sensitive was tested when it was pushed, and `sensitive` carries
  // that down. Rebuilding the full path at every level and rescanning the
  // growing string with two regexes made this quadratic: a 20,000-deep chain
  // of ordinary `metadata` keys cost seconds of synchronous work on an error
  // path, under the `MAX_INPUT_NODES` ceiling the whole time. The path was
  // read for nothing else, so it is gone rather than bounded.
  const stack: Array<{ node: unknown; sensitive: boolean }> = [
    { node: input, sensitive: false },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    if (nodes++ > MAX_INPUT_NODES) return false;
    const cur = stack.pop() as { node: unknown; sensitive: boolean };
    const v = cur.node;
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
      if (cur.sensitive) addCandidate(out, String(v));
      continue;
    }
    if (v === null || typeof v !== "object") continue;
    const priorSensitive = seen.get(v);
    if (priorSensitive === true || (priorSensitive === false && !cur.sensitive)) continue;
    seen.set(v, cur.sensitive);
    if (Array.isArray(v)) {
      try {
        const len = v.length;
        for (let i = 0; i < len; i++) {
          if (nodes++ > MAX_INPUT_NODES) return false;
          // An element inherits its container's path: every entry of
          // `tokens` is as sensitive as `tokens` itself.
          const el = arrayElementValue(v, i);
          if (el === null) return false;
          stack.push({ node: el.value, sensitive: cur.sensitive });
        }
      } catch {
        return false;
      }
      continue;
    }
    const entries = enumerableDataEntries(v as object, MAX_INPUT_NODES - nodes);
    if (entries === null) return false;
    for (const [k, child] of entries) {
      if (nodes++ > MAX_INPUT_NODES) return false;
      stack.push({
        node: child,
        // Sensitivity is inherited, not re-decided: once inside a credential
        // container everything under it is a candidate.
        sensitive:
          cur.sensitive ||
          isSensitiveFieldPath(k) ||
          isCredentialContainerPath(k),
      });
    }
  }
  return true;
}

/**
 * Redact credentials a runtime message echoes as prose.
 *
 * Runs after `scrubSecrets`, which handles every recognisable SHAPE; this
 * handles the values that arrive in no shape at all. A partial or
 * budget-exhausted walk fails closed, for the same reason the Zod path does:
 * redacting against a set that may be missing the very value being echoed
 * would report success while leaking.
 */
function redactSensitiveEchoes(
  message: string,
  params: unknown,
  credentials?: unknown,
  rawParams?: unknown,
): string {
  const candidates = new Set<string>();
  if (params !== undefined && params !== null) {
    if (!collectSensitiveInputStrings(params, candidates)) return "[REDACTED]";
  }
  // Both representations, because sensitivity lives in the PATH and a
  // transform is precisely the operation that discards paths. A schema
  // rewriting `{ password }` into `{ value }` leaves the validated object with
  // no sensitively-named field at all, so a handler throwing `rejected
  // hunter2` collected no candidate and the credential reached the envelope.
  // The validated form is what the handler saw and most likely interpolated;
  // the raw form still carries the field names.
  //
  // The limit, stated so it is not discovered later: this recovers a RENAMED
  // field, not a DERIVED one. A transform that decodes or reformats the value
  // (`atob`, a trim, a JSON parse) produces a string present in neither
  // collection, and no amount of path-tracking reaches it — the same
  // "arbitrary transform is not derivable" boundary documented above
  // {@link collectInputStrings}. This widens the net to the cases where the
  // value survives intact, which is most of them.
  if (rawParams !== undefined && rawParams !== null && rawParams !== params) {
    if (!collectSensitiveInputStrings(rawParams, candidates)) {
      return "[REDACTED]";
    }
  }
  // Credentials contribute EVERY string, not only the sensitively-named ones.
  // A credentials object is secret by construction — that is what makes it
  // credentials — so there is no benign half to preserve, and the field names a
  // provider chooses (`sessionId`, `pat`, `bearer`) need not be in any
  // vocabulary. Reported as a gap after the params-only version shipped: a
  // handler echoing `ctx.credentials.token` collected no candidate at all.
  if (credentials !== undefined && credentials !== null) {
    if (!collectInputStrings(credentials, candidates)) return "[REDACTED]";
  }
  if (candidates.size === 0) return message;
  const echo = makeEchoRedactor(candidates);
  const out = echo.redact(message);
  return echo.exhausted() ? "[REDACTED]" : out;
}

function defaultErrorMap(
  err: unknown,
  params?: unknown,
): {
  error_code: ErrorCode;
  message: string;
} {
  // Structural check instead of `instanceof z.ZodError` because consumers
  // may install toolkit via `file:` deps or otherwise end up with their
  // own zod instance — instanceof would return false and the error would
  // leak through as a misclassified CONNECTION_ERROR. Duck-typing on
  // `name === "ZodError"` + shape catches every zod instance regardless
  // of module identity.
  if (isZodErrorLike(err)) {
    const inputStrings = new Set<string>();
    const collected = collectInputStrings(params, inputStrings);
    // Replace what the caller passed in, in place, rather than deciding
    // whether to drop the message around it.
    //
    // Dropping-on-echo was wrong in kind, not in degree: it lost a constant
    // diagnostic whenever an input string happened to occur inside it
    // (`filter: "query_logs"` blanked the `query_logs` schema's own
    // exactly-one-filter instruction), while a value below the length cutoff
    // still escaped entirely. Those are opposite failures of one substring
    // test used as a boolean.
    //
    // Redacting the occurrences keeps every word the author wrote that is not
    // the caller's own input, so `rejected value xy` becomes `rejected value
    // [REDACTED]` and the exactly-one-filter instruction survives with only
    // the echoed token removed. It also makes the length cutoff cheap: an
    // over-inclusive match now costs one substring, not the diagnostic.
    //
    // Longest first — a short value can be a substring of a longer one, and
    // replacing the short one first would leave the longer one's remainder
    // standing.
    const echo = makeEchoRedactor(inputStrings);
    const redactEchoedInput = echo.redact;
    const msg = err.issues
      .map((i) => {
        const joined = i.path.join(".");
        // The PATH is redacted as well as the message. A custom refinement can
        // put the rejected value in the path itself — `{ path: [v.password],
        // message: "invalid" }` renders as `hunter2: invalid` — and the
        // shape-based scrub sees no `key = value` in that prose. Same redactor
        // and therefore the same candidates, so a path segment that is the
        // caller's own input is removed while an ordinary field name is not.
        const path = redactEchoedInput(joined) || "<root>";
        // Issue text is author-controlled prose and can name the rejected
        // value without any `key = value` shape for `scrubSecrets` to find
        // (`password: rejected value hunter2` scrubbed to
        // `password: "[REDACTED]" value hunter2`). When the path itself says
        // the field is a credential, drop the message instead of scrubbing
        // it. The path is kept, so the caller still learns which field failed.
        //
        // The path test above is blind to an issue raised on the object
        // rather than on one of its fields, and to a `custom` issue raised at
        // a nested but non-sensitive path (`credentials`, say) — both carry
        // author prose that can name the rejected value.
        //
        // `echoesInput` is the rule that actually decides it: a message is a
        // leak exactly when it contains something the caller passed in. That
        // replaced an earlier `code === "custom"` test, which was a proxy and
        // wrong in both directions — it missed a custom issue at any nested
        // path, and it blanked constant `.refine` diagnostics that never touch
        // the input at all (the `query_logs` schema in
        // `src/connectors/gcp/index.ts` lost its "exactly one filter"
        // instruction that way). Keying on the input needs no guess about what
        // an author's message might contain, and it works at every depth.
        //
        // The pathless `mentionsSensitiveField` check stays as a backstop for
        // a message naming a credential whose value did not come through
        // params — read from the environment, say — where there is nothing to
        // match against.
        // `!collected` fails closed. The walk stopped early, so `inputStrings`
        // may be missing the very value this message echoes, and redacting
        // against a partial set would report success while leaking. A dropped
        // message keeps the path, so the caller still learns which field
        // failed.
        const drop =
          !collected ||
          echo.exhausted() ||
          isSensitiveFieldPath(path) ||
          (joined === "" && mentionsSensitiveField(i.message));
        return `${path}: ${drop ? "[REDACTED]" : redactEchoedInput(i.message)}`;
      })
      .join("; ");
    return { error_code: "VALIDATION_ERROR", message: msg };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Heuristic mapping — connectors override via mapError for service-specific codes.
  const lower = message.toLowerCase();
  if (
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("network")
  ) {
    return { error_code: "CONNECTION_ERROR", message };
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return { error_code: "TIMEOUT", message };
  }
  if (
    lower.includes("401") ||
    lower.includes("unauthor") ||
    lower.includes("forbidden")
  ) {
    return { error_code: "AUTH_ERROR", message };
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return { error_code: "NOT_FOUND", message };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return { error_code: "RATE_LIMITED", message };
  }
  if (lower.includes("sdk") && lower.includes("not installed")) {
    return { error_code: "CONFIG_ERROR", message };
  }
  return { error_code: "CONNECTION_ERROR", message };
}

// ───────────────────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────────────────

export function createConnector<TSdk = unknown>(
  cfg: ConnectorConfig<TSdk>,
): Connector {
  if (cfg.name.length === 0) {
    throw new Error("createConnector: 'name' is required");
  }
  if (Object.keys(cfg.actions).length === 0) {
    throw new Error(
      `createConnector(${cfg.name}): at least one action must be declared`,
    );
  }

  const validActions: ReadonlySet<string> = new Set(Object.keys(cfg.actions));

  // Policy config — loaded once per connector instance.
  let loadedPolicy: LoadedPolicy | null = null;
  let policyLoadError: string | null = null;
  if (cfg.disablePolicyDiscovery !== true) {
    try {
      loadedPolicy = loadPolicyConfig({
        name: cfg.name,
        floorAspects: cfg.policyFloorAspects ?? [],
        ...(cfg.policyConfigPath !== undefined
          ? { explicitPath: cfg.policyConfigPath }
          : {}),
      });
    } catch (err) {
      // Surface config errors deterministically on first call via fetch.
      // Scrub first: policy files carry connection strings and credential
      // fields, and a parse/validation failure routinely echoes the offending
      // value. This string lands verbatim in the CONFIG_ERROR envelope below,
      // which `main` writes to stdout.
      // DO NOT REMOVE: pinned by tests/toolkit/connector.test.ts.
      policyLoadError = scrubSecrets(
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const rules: PolicyRules =
    loadedPolicy?.rules ?? cfg.defaultPolicy ?? DEFAULT_POLICY;
  const approvalMode: ApprovalMode = loadedPolicy?.approval_mode ?? "auto";

  // Audit + approval engine + hardship recorder (all instance-scoped).
  const audit: AuditWriter = createAuditWriter(
    cfg.audit !== undefined
      ? {
          enabled: cfg.audit.enabled,
          ...(cfg.audit.path !== undefined ? { path: cfg.audit.path } : {}),
        }
      : { enabled: false },
  );
  const approvals = new ApprovalEngine({
    onGrantExpired: (grantType) =>
      audit.logEvent({ event_type: "grant_expired", grant_type: grantType }),
  });
  const recorder: HardshipRecorder =
    cfg.hardship?.recorder ??
    createHardshipRecorder({
      connector: cfg.name,
      ...(cfg.hardship?.enabled !== undefined
        ? { enabled: cfg.hardship.enabled }
        : {}),
      sessionId: audit.sessionId,
    });

  // Lazy SDK loading — only on first success decision.
  let sdkPromise: Promise<TSdk> | null = null;
  const loadSdk = async (): Promise<TSdk> => {
    if (cfg.sdk === undefined) return undefined as unknown as TSdk;
    if (sdkPromise === null) sdkPromise = cfg.sdk();
    return sdkPromise;
  };

  // Lazy credentials loading — only on first success decision.
  let credsPromise: Promise<Credentials> | null = null;
  const loadCreds = async (): Promise<Credentials> => {
    if (credsPromise === null) credsPromise = cfg.credentials();
    return credsPromise;
  };

  // Track last successful SDK resolution for recordResolution defaulting.
  let lastCtx: { sdk: TSdk; action: string; params: unknown } | null = null;

  // ─── fetch ──────────────────────────────────────────────────────────────
  const fetch = async (action: string, params: unknown): Promise<Envelope> => {
    // Argument validation: action must be registered.
    if (!validActions.has(action)) {
      return {
        status: "error",
        action,
        error_code: "VALIDATION_ERROR",
        message: `Unknown action '${action}'. Valid: ${[...validActions].join(", ")}`,
        retriable: false,
      };
    }
    if (policyLoadError !== null) {
      return {
        status: "error",
        action,
        error_code: "CONFIG_ERROR",
        message: `Policy config error: ${policyLoadError}`,
        retriable: false,
      };
    }

    const spec = cfg.actions[action]!;
    const start = Date.now();

    // 1. Validate params via Zod.
    const parsed = spec.params.safeParse(params);
    if (!parsed.success) {
      const mapped = defaultErrorMap(parsed.error, params);
      // Zod issue text is author-controlled and routinely interpolates the
      // rejected value (`superRefine` with a custom message, enum/literal
      // mismatches). `defaultErrorMap` concatenates every issue message, so a
      // schema that rejects a malformed credential echoes it here — and this
      // envelope is what `main()` writes to stdout. Scrub once, before both
      // sinks: the envelope below and the hardship context recorded after it.
      const message = scrubSecrets(mapped.message);
      const env: ErrorEnvelope = {
        status: "error",
        action,
        error_code: mapped.error_code,
        message,
        retriable: false,
      };
      audit.logEvent({
        event_type: "action",
        connector: cfg.name,
        action,
        status: "error",
        execution_time_ms: Date.now() - start,
      } as never);
      recorder({
        action,
        kind: "validation",
        context: message,
        scope: safeScope(cfg, {
          sdk: undefined as unknown as TSdk,
          action,
          params,
        }),
      });
      return env;
    }
    const validated = parsed.data;

    // 2. Classify (factory hook wins; else per-action static/fn classify).
    let classification: Classification;
    try {
      if (cfg.classify !== undefined) {
        classification = await cfg.classify(action, validated);
      } else if (typeof spec.classify === "function") {
        classification = (spec.classify as (p: unknown) => Classification)(
          validated,
        );
      } else {
        classification = spec.classify;
      }
    } catch (err) {
      // Same two-stage redaction as the handler path: shapes first, then the
      // values the caller supplied. A hook that echoes a validated parameter
      // as prose presents no shape at all, and this envelope reaches stdout.
      // Credentials are not loaded yet at this point in the sequence.
      const message = redactSensitiveEchoes(
        scrubSecrets(err instanceof Error ? err.message : String(err)),
        validated,
        undefined,
        params,
      );
      return errorEnvelope(
        action,
        "CONFIG_ERROR",
        `classify() threw: ${message}`,
        false,
        start,
      );
    }

    // 3. Policy gate.
    let decision: Decision = checkPolicy(
      classification,
      rules,
      approvalMode,
      approvals,
    );

    // 4. extendDecision hook: may widen Decision into an ExtendedEnvelope.
    let extended: Decision | ExtendedEnvelope = decision;
    if (cfg.extendDecision !== undefined) {
      try {
        extended = cfg.extendDecision(decision, {
          action,
          params: validated,
          classification,
        });
      } catch (err) {
        // Same as the classify() catch above, and found with it: fixing one
        // hook and not its sibling is how the previous round's gap survived.
        const message = redactSensitiveEchoes(
          scrubSecrets(err instanceof Error ? err.message : String(err)),
          validated,
          undefined,
          params,
        );
        return errorEnvelope(
          action,
          "CONFIG_ERROR",
          `extendDecision() threw: ${message}`,
          false,
          start,
        );
      }
    }

    audit.logEvent({
      event_type: `policy_${decision.status}` as never,
      connector: cfg.name,
      action,
      reason: decision.reason,
      kind: classification.kind,
      ...(classification.aspects !== undefined
        ? { aspects: classification.aspects }
        : {}),
    } as never);

    // 5. If not a base success, the caller gets an envelope now (no SDK load).
    if (isEnvelopeLike(extended)) {
      return toEnvelope(cfg.name, action, extended, start, audit);
    }
    if (decision.status === "denied") {
      const deniedScope = safeScope(cfg, {
        sdk: undefined as unknown as TSdk,
        action,
        params: validated,
      });
      const deniedHitOpts: Parameters<typeof readFirstMatchingPattern>[0] = {
        connector: cfg.name,
        scope: deniedScope,
        facts: { kind: "policy_denied", action, context: decision.reason },
      };
      if (cfg.runtime?.cwd !== undefined) deniedHitOpts.cwd = cfg.runtime.cwd;
      if (cfg.runtime?.home !== undefined)
        deniedHitOpts.home = cfg.runtime.home;
      const deniedHit = readFirstMatchingPattern(deniedHitOpts);
      const env: DeniedEnvelope = {
        status: "denied",
        action,
        reason: decision.reason,
        ...(deniedHit
          ? {
              resolution_hint: {
                pattern_id: deniedHit.match.pattern_id,
                advice: deniedHit.match.advice,
                confidence: deniedHit.match.confidence,
                scope: deniedHit.scopeLevel,
              },
            }
          : {}),
      };
      auditAction(audit, cfg.name, action, "denied", start);
      return env;
    }
    if (decision.status === "escalate") {
      const escalateScope = safeScope(cfg, {
        sdk: undefined as unknown as TSdk,
        action,
        params: validated,
      });
      const escalateHitOpts: Parameters<typeof readFirstMatchingPattern>[0] = {
        connector: cfg.name,
        scope: escalateScope,
        facts: { kind: "policy_escalate", action, context: decision.reason },
      };
      if (cfg.runtime?.cwd !== undefined) escalateHitOpts.cwd = cfg.runtime.cwd;
      if (cfg.runtime?.home !== undefined)
        escalateHitOpts.home = cfg.runtime.home;
      const escalateHit = readFirstMatchingPattern(escalateHitOpts);
      const env: EscalateEnvelope = {
        status: "escalate",
        action,
        reason: decision.reason,
        ...(escalateHit
          ? {
              resolution_hint: {
                pattern_id: escalateHit.match.pattern_id,
                advice: escalateHit.match.advice,
                confidence: escalateHit.match.confidence,
                scope: escalateHit.scopeLevel,
              },
            }
          : {}),
      };
      auditAction(audit, cfg.name, action, "escalate", start);
      return env;
    }
    // 6. decision.status === "success". Load SDK + creds lazily, run handler.
    let sdk: TSdk;
    let credentials: Credentials;
    // One rejection used to leave the destructuring unassigned, so a `sdk()`
    // failure whose message echoes a credential reached the redactor with
    // `credentials === undefined` and no candidate — and setup prose carries
    // no `key = value` shape for `scrubSecrets` to find either. The
    // credentials that DID resolve are the ones most likely to be named.
    //
    // Recorded as it settles rather than by `allSettled`, which waits for
    // EVERY sibling: a fast configuration failure paired with a hung
    // network-backed loader turned a reportable setup error into a request
    // that never resolved at all. `Promise.all` still rejects on the first
    // failure, and the credential is already captured if it arrived first.
    let loadedCreds: Credentials | undefined;
    let credsUnavailable = false;
    const sdkPromise = loadSdk();
    const credsPromise = loadCreds().then(
      (c) => {
        loadedCreds = c;
        return c;
      },
      (e) => {
        // The loader read a credential and then failed. There is nothing to
        // collect, so nothing can be matched, and its message is the one most
        // likely to name what it just read. Fails closed below.
        credsUnavailable = true;
        throw e;
      },
    );
    // Keep a handler attached: if the credentials loader rejects first,
    // `Promise.all` settles and this one would otherwise be unhandled.
    sdkPromise.catch(() => undefined);
    try {
      [sdk, credentials] = await Promise.all([sdkPromise, credsPromise]);
    } catch (err) {
      return mapAndBuildError(
        err,
        action,
        cfg,
        audit,
        recorder,
        classification,
        start,
        undefined as unknown as TSdk,
        validated,
        loadedCreds,
        params,
        credsUnavailable,
      );
    }

    lastCtx = { sdk, action, params: validated };

    const ctx: Context<TSdk> = {
      sdk,
      credentials,
      policy: decision,
      recordHardship: recorder,
      logger: {
        debug: (msg: string) =>
          audit.logEvent({ event_type: "debug", details: { msg } } as never),
        warn: (msg: string) =>
          audit.logEvent({ event_type: "warn", details: { msg } } as never),
      },
    };

    let data: unknown;
    try {
      data = await spec.handler(validated as never, ctx);
    } catch (err) {
      // Handlers can emit any envelope shape via EnvelopeOverride.
      if (err instanceof EnvelopeOverride) {
        const envOverride = { ...err.envelope, action } as ExtendedEnvelope;
        auditAction(audit, cfg.name, action, envOverride.status, start);
        return envOverride;
      }
      return mapAndBuildError(
        err,
        action,
        cfg,
        audit,
        recorder,
        classification,
        start,
        sdk,
        validated,
        credentials,
        params,
      );
    }

    const env: SuccessEnvelope = {
      status: "success",
      action,
      data: isRecord(data) ? data : { result: data },
    };
    auditAction(audit, cfg.name, action, "success", start);
    return env;
  };

  // ─── main ───────────────────────────────────────────────────────────────
  const main = async (argv: readonly string[]): Promise<number> => {
    // --help / --curate / --version are handled here before action dispatch.
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp(cfg);
      return 0;
    }
    if (argv.includes("--curate")) {
      const snap = buildCurateSnapshot({ connector: cfg.name });
      process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
      return 0;
    }
    if (argv.includes("--version") || argv.includes("-v")) {
      process.stdout.write(`${cfg.name} ${cfg.version ?? ""}\n`);
      return 0;
    }

    // Argument errors emit a structured envelope on stdout (status=error,
    // error_code=VALIDATION_ERROR) so consumers parsing JSON from stdout never
    // hit the case where stdout is empty and the failure is text on stderr.
    // Exit code is 2 (CLI misuse), distinct from 1 (handled action-level error).
    const writeArgErrorEnvelope = (action: string, message: string): void => {
      const scrubbed = scrubSecrets(message);
      const env = {
        status: "error",
        action,
        error_code: "VALIDATION_ERROR",
        message: scrubbed,
        retriable: false,
      };
      process.stdout.write(JSON.stringify(env) + "\n");
      process.stderr.write(`argument error: ${scrubbed}\n`);
    };

    let parsed;
    try {
      parsed = parseAgentArgs(argv, { flags: ["action", "params"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeArgErrorEnvelope("<unknown>", msg);
      return 2;
    }

    const action = parsed.action;
    const paramsRaw = parsed.params ?? "{}";
    if (typeof action !== "string" || action.length === 0) {
      writeArgErrorEnvelope("<unknown>", "--action is required");
      return 2;
    }
    let params: unknown;
    try {
      params = JSON.parse(paramsRaw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeArgErrorEnvelope(action, `--params must be valid JSON (${msg})`);
      return 2;
    }

    const env = await fetch(action, params);
    process.stdout.write(JSON.stringify(env) + "\n");
    return exitCodeForEnvelope(env);
  };

  return {
    main,
    fetch,
    validActions,
    name: cfg.name,
    recordResolution(input) {
      const scope =
        input.scope !== undefined
          ? input.scope
          : lastCtx && cfg.scope
            ? safeScope(cfg, lastCtx)
            : null;
      recorder({
        action: input.action ?? lastCtx?.action ?? "unknown",
        kind: "resolution",
        context: `pattern=${input.pattern_id}`,
        resolution: input.advice,
        scope,
      });
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEnvelopeLike(v: unknown): v is ExtendedEnvelope {
  if (!isRecord(v)) return false;
  const status = v["status"];
  if (typeof status !== "string") return false;
  // Base decision statuses (success/denied/escalate) come back from
  // checkPolicy without an `action` field; anything else is an extension.
  const action = v["action"];
  return typeof action === "string";
}

function toEnvelope(
  connector: string,
  action: string,
  value: Decision | ExtendedEnvelope,
  start: number,
  audit: AuditWriter,
): Envelope {
  if (isEnvelopeLike(value)) {
    auditAction(audit, connector, action, value.status, start);
    return value;
  }
  // Fallback: decision without envelope form (shouldn't hit in practice —
  // main path handles base decisions explicitly).
  auditAction(audit, connector, action, value.status, start);
  return {
    status: value.status,
    action,
    message: value.reason,
    extension: {},
  } as ExtendedEnvelope;
}

function auditAction(
  audit: AuditWriter,
  connector: string,
  action: string,
  status: string,
  start: number,
): void {
  audit.logEvent({
    event_type: "action",
    connector,
    action,
    status,
    execution_time_ms: Date.now() - start,
  } as never);
}

function errorEnvelope(
  action: string,
  code: ErrorCode,
  message: string,
  retriable: boolean,
  _start: number,
): ErrorEnvelope {
  return {
    status: "error",
    action,
    error_code: code,
    message,
    retriable,
  };
}

function safeScope<TSdk>(
  cfg: ConnectorConfig<TSdk>,
  ctx: { sdk: TSdk; action: string; params: unknown },
): string | null {
  if (!cfg.scope) return null;
  try {
    return cfg.scope(ctx);
  } catch {
    return null;
  }
}

function mapAndBuildError<TSdk>(
  err: unknown,
  action: string,
  cfg: ConnectorConfig<TSdk>,
  audit: AuditWriter,
  recorder: HardshipRecorder,
  _classification: Classification,
  start: number,
  sdk: TSdk,
  params: unknown,
  credentials?: unknown,
  rawParams?: unknown,
  /**
   * The credentials loader itself failed, so no credential is available to
   * redact against. Its message is the one most likely to name what it had
   * just read, and there is nothing to match it with — so the message is
   * dropped whole rather than redacted against an empty set.
   */
  credentialsUnavailable = false,
): ErrorEnvelope {
  let code: ErrorCode;
  let message: string;
  let retriable: boolean;

  const override = cfg.mapError?.(err, action);
  if (override?.error_code !== undefined && override?.message !== undefined) {
    code = override.error_code;
    message = override.message;
    retriable = override.retriable ?? RETRIABLE_CODES.has(code);
  } else {
    const def = defaultErrorMap(err, params);
    code = def.error_code;
    message = def.message;
    retriable = RETRIABLE_CODES.has(code);
  }

  // Redact before the message reaches ANY sink. This is the primary runtime
  // error path (handler throws, credential/SDK loading fails), so an
  // unscrubbed `message` here lands in the ErrorEnvelope that `main` writes
  // to stdout — the same leak the classify()/extendDecision() paths guard
  // against. `mapError` overrides are scrubbed too: a connector's custom
  // mapper commonly interpolates the raw driver error.
  // DO NOT REMOVE: pinned by tests/toolkit/connector.test.ts.
  message = scrubSecrets(message);
  // `scrubSecrets` recognises shapes; a handler echoing a credential as prose
  // presents none. This is the same input-aware redaction the validation path
  // has always done, scoped to sensitive paths so an ordinary diagnostic that
  // names a benign parameter survives.
  // DO NOT REMOVE: pinned by tests/toolkit/connector.test.ts.
  message = credentialsUnavailable
    ? "[REDACTED]"
    : redactSensitiveEchoes(message, params, credentials, rawParams);

  const scope = safeScope(cfg, { sdk, action, params });

  auditAction(audit, cfg.name, action, "error", start);
  recorder({
    action,
    kind: code.toLowerCase(),
    context: message,
    scope,
  });

  const hitOpts: Parameters<typeof readFirstMatchingPattern>[0] = {
    connector: cfg.name,
    scope,
    facts: {
      kind: code.toLowerCase(),
      action,
      context: message,
    },
  };
  if (cfg.runtime?.cwd !== undefined) hitOpts.cwd = cfg.runtime.cwd;
  if (cfg.runtime?.home !== undefined) hitOpts.home = cfg.runtime.home;
  const hit = readFirstMatchingPattern(hitOpts);

  return {
    status: "error",
    action,
    error_code: code,
    message,
    retriable,
    ...(hit
      ? {
          resolution_hint: {
            pattern_id: hit.match.pattern_id,
            advice: hit.match.advice,
            confidence: hit.match.confidence,
            scope: hit.scopeLevel,
          },
        }
      : {}),
  };
}

function exitCodeForEnvelope(env: Envelope): number {
  const status = (env as { status?: unknown }).status;
  if (status === "success") return 0;
  // Connector-extended "presentation" statuses (e.g. db-agent's present_only)
  // exit 0 since they represent a valid non-error response.
  if (typeof status === "string" && status.startsWith("present")) return 0;
  return 1;
}

function printHelp<TSdk>(cfg: ConnectorConfig<TSdk>): void {
  const lines = [
    `${cfg.name}${cfg.version ? ` (${cfg.version})` : ""}`,
    "",
    "Usage:",
    `  ${cfg.name} --action <name> --params '<json>'`,
    `  ${cfg.name} --curate                 # dump hardship clusters as JSON`,
    `  ${cfg.name} --help | --version`,
    "",
    "Actions:",
  ];
  for (const [name, spec] of Object.entries(cfg.actions)) {
    const desc = spec.description ?? "";
    lines.push(`  ${name.padEnd(24)} ${desc}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}
