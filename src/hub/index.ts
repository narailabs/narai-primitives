/** Public API: `gather()` — plans connector calls from a prompt and dispatches
 *  them in parallel as subprocesses. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadResolvedConfig, type ResolvedConnector } from "narai-primitives/config";
import { resolveAgentCli } from "narai-primitives/toolkit";

import { dispatchPlan } from "./dispatch.js";
import {
  AgentSdkPlanner,
  buildSystemPrompt,
  buildUserPrompt,
  extractJsonArray,
  validatePlan,
} from "./plan.js";
import type {
  CliResolver,
  DispatchResult,
  GatherDeps,
  GatherInput,
  GatherOutput,
  PreparedConnector,
} from "./types.js";

export type {
  CliResolver,
  DispatchResult,
  GatherDeps,
  GatherInput,
  GatherOutput,
  Planner,
  PlanStep,
  PreparedConnector,
  SpawnFn,
} from "./types.js";

export { AgentSdkPlanner, buildSystemPrompt, buildUserPrompt, extractJsonArray, validatePlan } from "./plan.js";
export { dispatchPlan } from "./dispatch.js";

/** Strip `-agent-connector` suffix to get the short name expected by `resolveAgentCli`. */
function shortName(skill: string): string {
  return skill.replace(/-agent-connector$/, "");
}

/** Walk up from a connector CLI path to the narai-primitives package root.
 *
 * Two layouts to handle:
 *   - Bundled 2.x: `<root>/dist/connectors/<name>/cli.js` (walk up 4)
 *   - Legacy:     `<root>/dist/cli.js` (walk up 2 — pre-2.0 per-connector packages)
 */
function packageRootFromCli(cliPath: string): string {
  const parts = cliPath.split(path.sep);
  const distIdx = parts.lastIndexOf("dist");
  if (distIdx > 0 && parts[distIdx + 1] === "connectors") {
    // <root>/dist/connectors/<name>/cli.js → <root>
    return parts.slice(0, distIdx).join(path.sep);
  }
  // <root>/dist/cli.js → <root>
  return path.dirname(path.dirname(cliPath));
}

/** Candidate SKILL.md paths under a package root, in preference order. */
function skillMdCandidates(root: string, name: string): string[] {
  return [
    // Bundled 2.x: plugins/<name>-agent/skills/<name>-agent/SKILL.md
    path.join(root, "plugins", `${name}-agent`, "skills", `${name}-agent`, "SKILL.md"),
    // Legacy: plugin/skills/<name>-agent/SKILL.md (pre-2.0 per-connector packages)
    path.join(root, "plugin", "skills", `${name}-agent`, "SKILL.md"),
  ];
}

/** Read a file synchronously, returning null on failure. */
function tryRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Default CLI resolver — wraps `resolveAgentCli` with a one-arg signature. */
const defaultCliResolver: CliResolver = (name) => resolveAgentCli({ name });

/** Resolve one connector's bin + SKILL.md content. */
function prepareConnector(
  slice: ResolvedConnector,
  cliResolver: CliResolver,
): { prepared: PreparedConnector } | { error: { code: string; message: string } } {
  const skill = slice.skill;
  // Path-style skill: SKILL.md from the path; bin from `options.bin`.
  if (skill.startsWith("~") || skill.startsWith("/") || skill.startsWith(".")) {
    const expanded = skill.startsWith("~")
      ? path.join(os.homedir(), skill.slice(1))
      : skill;
    const skillFile = path.join(expanded, "SKILL.md");
    const skillContent = tryRead(skillFile);
    if (skillContent === null) {
      return {
        error: {
          code: "SKILL_NOT_FOUND",
          message: `SKILL.md not found at ${skillFile}`,
        },
      };
    }
    const binOpt = slice.options["bin"];
    if (typeof binOpt !== "string" || binOpt === "") {
      return {
        error: {
          code: "CONFIG_ERROR",
          message: `connector '${slice.name}' uses path-style skill but has no 'bin' option`,
        },
      };
    }
    return {
      prepared: {
        name: slice.name,
        binCommand: "node",
        binArgs: [binOpt],
        skillContent,
        slice,
      },
    };
  }

  // Built-in skill: resolve bin via the injected resolver + read SKILL.md from package root.
  const name = shortName(skill);
  const resolved = cliResolver(name);
  if (resolved === null) {
    return {
      error: {
        code: "CLI_NOT_FOUND",
        message: `could not resolve CLI for connector '${slice.name}' (short name: ${name})`,
      },
    };
  }
  const root = packageRootFromCli(resolved.resolvedPath);
  const candidates = skillMdCandidates(root, name);
  let skillContent: string | null = null;
  for (const candidate of candidates) {
    const content = tryRead(candidate);
    if (content !== null) {
      skillContent = content;
      break;
    }
  }
  if (skillContent === null) {
    return {
      error: {
        code: "SKILL_NOT_FOUND",
        message: `SKILL.md not found at any of: ${candidates.join(", ")}`,
      },
    };
  }
  return {
    prepared: {
      name: slice.name,
      binCommand: resolved.command,
      binArgs: resolved.args,
      skillContent,
      slice,
    },
  };
}

/** Plan + dispatch connector calls from a natural-language prompt. */
export async function gather(input: GatherInput, deps: GatherDeps = {}): Promise<GatherOutput> {
  const configLoader = deps.configLoader ?? loadResolvedConfig;
  const planner = deps.planner ?? new AgentSdkPlanner();
  const cliResolver = deps.cliResolver ?? defaultCliResolver;

  // Step 1 — load config.
  const loadOpts: { consumer?: string; environment?: string } = {};
  if (input.consumer !== undefined) loadOpts.consumer = input.consumer;
  if (input.environment !== undefined) loadOpts.environment = input.environment;
  const resolved = await configLoader(loadOpts);

  // Step 2 — prepare each enabled connector.
  const prepared: PreparedConnector[] = [];
  const prepErrors: DispatchResult[] = [];
  let syntheticIdx = 0;
  for (const [name, slice] of Object.entries(resolved.connectors)) {
    if (!slice.enabled) continue;
    const result = prepareConnector(slice, cliResolver);
    if ("error" in result) {
      syntheticIdx++;
      prepErrors.push({
        step: syntheticIdx,
        connector: name,
        action: "<prepare>",
        params: {},
        error: result.error,
      });
      continue;
    }
    prepared.push(result.prepared);
  }

  if (prepared.length === 0) {
    return { plan: [], results: prepErrors };
  }

  // Step 3 — plan.
  const systemPrompt = buildSystemPrompt(prepared);
  const userPrompt = buildUserPrompt(input.prompt, input.extraContext);
  let raw: string;
  try {
    raw = await planner.plan(systemPrompt, userPrompt);
  } catch (err) {
    const msg = (err as Error).message;
    const code =
      msg.includes("authentic") || msg.includes("session") || msg.includes("OAuth")
        ? "NO_CLAUDE_CODE_SESSION"
        : "PLANNER_FAILED";
    return {
      plan: [],
      results: [
        ...prepErrors,
        {
          step: prepErrors.length + 1,
          connector: "<planner>",
          action: "<plan>",
          params: {},
          error: { code, message: msg },
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonArray(raw);
  } catch (err) {
    return {
      plan: [],
      results: [
        ...prepErrors,
        {
          step: prepErrors.length + 1,
          connector: "<planner>",
          action: "<plan>",
          params: {},
          error: {
            code: "PLANNER_INVALID",
            message: `could not parse planner JSON: ${(err as Error).message}`,
          },
        },
      ],
    };
  }

  const enabledNames = new Set(prepared.map((p) => p.name));
  const validation = validatePlan(parsed, enabledNames);

  // Synthesize an error per dropped entry (offset after prep errors).
  const planEntryErrors: DispatchResult[] = validation.invalid.map((bad, i) => ({
    step: prepErrors.length + i + 1,
    connector:
      isPlainObject(bad.entry) && typeof bad.entry["connector"] === "string"
        ? (bad.entry["connector"] as string)
        : "<unknown>",
    action:
      isPlainObject(bad.entry) && typeof bad.entry["action"] === "string"
        ? (bad.entry["action"] as string)
        : "<unknown>",
    params: {},
    error: { code: "PLAN_ENTRY_INVALID", message: bad.reason },
  }));

  // Step 4 — dispatch.
  const preparedByName = new Map(prepared.map((p) => [p.name, p]));
  const dispatchResults = await dispatchPlan(validation.valid, preparedByName, {
    ...(deps.spawnProcess !== undefined ? { spawnProcess: deps.spawnProcess } : {}),
  });

  // Renumber dispatch results so `step` is contiguous in the final output.
  const offset = prepErrors.length + planEntryErrors.length;
  const renumbered = dispatchResults.map((r, i) => ({ ...r, step: offset + i + 1 }));

  return {
    plan: validation.valid,
    results: [...prepErrors, ...planEntryErrors, ...renumbered],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
