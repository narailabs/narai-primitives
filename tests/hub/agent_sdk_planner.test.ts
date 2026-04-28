/** Tests for the AgentSdkPlanner class — the default `Planner` impl that
 *  drives the Claude Agent SDK. We mock the SDK module so no network is hit. */

import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (params: { prompt: string; options?: { systemPrompt?: string } }) => {
      const { prompt } = params;
      if (prompt === "FAIL") {
        async function* gen() {
          yield {
            type: "result" as const,
            subtype: "error_during_execution" as const,
          };
        }
        return gen();
      }
      if (prompt === "EMPTY") {
        async function* gen() {
          yield {
            type: "result" as const,
            subtype: "success" as const,
            result: "",
          };
        }
        return gen();
      }
      async function* gen() {
        yield {
          type: "result" as const,
          subtype: "success" as const,
          result: '[{"connector":"aws","action":"x","params":{}}]',
        };
      }
      return gen();
    },
  };
});

// Dynamic import is required: `vi.mock` is hoisted to the top of the file but
// only takes effect for module loads that happen after the call. A static
// `import` would resolve before the mock is registered.
const { AgentSdkPlanner } = await import("../../src/hub/plan.js");

describe("AgentSdkPlanner", () => {
  it("returns the SDK's success result string", async () => {
    const p = new AgentSdkPlanner();
    const out = await p.plan("system", "user prompt");
    expect(out).toBe('[{"connector":"aws","action":"x","params":{}}]');
  });

  it("throws on result subtype other than success", async () => {
    const p = new AgentSdkPlanner();
    await expect(p.plan("system", "FAIL")).rejects.toThrow(/planner failed/);
  });

  it("throws when planner returns empty", async () => {
    const p = new AgentSdkPlanner();
    await expect(p.plan("system", "EMPTY")).rejects.toThrow(/no result/);
  });
});
