/** Planner-prompt builder, response JSON extraction, plan validation, and the
 *  default Agent SDK planner. */

import type { PlanStep, Planner, PreparedConnector } from "./types.js";

/** Build the system prompt by concatenating each connector's SKILL.md verbatim. */
export function buildSystemPrompt(connectors: readonly PreparedConnector[]): string {
  const sorted = [...connectors].sort((a, b) => a.name.localeCompare(b.name));
  const intro =
    "You are a planner for a set of read-only data connectors. Below is the documentation for each connector you may call, copied verbatim from its plugin skill.";
  const sections = sorted.map(
    (c) => `## Connector: \`${c.name}\`\n\n${c.skillContent.trim()}\n`,
  );
  const tail =
    'Given the user\'s prompt, return JSON: an array of objects with shape `{"connector": "<name>", "action": "<action>", "params": { ... }}`. Do not include any call whose required params you cannot fill from the prompt. Return `[]` if no connector is relevant. Return JSON only, no prose.';
  return [intro, ...sections, tail].join("\n\n");
}

/** Build the user-facing prompt portion. */
export function buildUserPrompt(prompt: string, extraContext?: string): string {
  if (extraContext === undefined || extraContext.trim() === "") return prompt;
  return `${prompt}\n\n--- extra context ---\n${extraContext}`;
}

/** Extract a JSON array from a possibly-prose-wrapped LLM response.
 *  Returns the parsed value (typed `unknown`), or throws on failure. */
export function extractJsonArray(raw: string): unknown {
  // First try a clean parse — best case, the model returned only JSON.
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  // Greedy match the first `[ ... ]` block. Defensive but acceptable for V1.
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match === null) {
    throw new Error("no JSON array found in planner response");
  }
  return JSON.parse(match[0]);
}

export interface PlanValidation {
  valid: PlanStep[];
  invalid: { entry: unknown; reason: string }[];
}

/** Validate raw plan entries; drop malformed ones with a recorded reason. */
export function validatePlan(
  raw: unknown,
  enabledConnectors: ReadonlySet<string>,
): PlanValidation {
  if (!Array.isArray(raw)) {
    return { valid: [], invalid: [{ entry: raw, reason: "plan is not an array" }] };
  }
  const valid: PlanStep[] = [];
  const invalid: { entry: unknown; reason: string }[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      invalid.push({ entry, reason: "entry is not a plain object" });
      continue;
    }
    const { connector, action, params } = entry;
    if (typeof connector !== "string" || !enabledConnectors.has(connector)) {
      invalid.push({ entry, reason: `unknown connector '${String(connector)}'` });
      continue;
    }
    if (typeof action !== "string" || action === "") {
      invalid.push({ entry, reason: "missing or empty action" });
      continue;
    }
    if (!isPlainObject(params)) {
      invalid.push({ entry, reason: "params must be a plain object" });
      continue;
    }
    valid.push({ connector, action, params });
  }
  return { valid, invalid };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Default planner: invokes `@anthropic-ai/claude-agent-sdk` `query()`. */
export class AgentSdkPlanner implements Planner {
  async plan(systemPrompt: string, userPrompt: string): Promise<string> {
    let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
    try {
      ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
    } catch (err) {
      throw new Error(
        `failed to load @anthropic-ai/claude-agent-sdk: ${(err as Error).message}`,
      );
    }
    const iter = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        maxTurns: 1,
        // The planner does not need any tools; it returns JSON via assistant text.
        tools: [],
      },
    });
    let final = "";
    for await (const msg of iter) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          final = msg.result;
        } else {
          throw new Error(`planner failed: ${msg.subtype}`);
        }
      }
    }
    if (final === "") {
      throw new Error("planner returned no result");
    }
    return final;
  }
}
