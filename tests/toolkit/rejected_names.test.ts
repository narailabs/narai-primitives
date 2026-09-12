// A caller-supplied NAME never reaches an error message.
//
// Two P1s on PR #207 reported the same defect at two producers:
// `parseAgentArgs` echoed `unrecognized argument: ghp_live_…` and
// `validateRules` echoed `policy: unknown key 'ghp_live_…'`. Both messages
// reach stdout and stderr — through `writeArgErrorEnvelope` and through the
// cached `policyLoadError` in every CONFIG_ERROR envelope — and `scrubSecrets`
// matches credential-bearing SHAPES, which a bare token in a name slot has
// none of.
//
// Measuring the class rather than the two instances found twelve producers
// across seven files, plus three more shapes nobody reported: a server ALIAS,
// an ASPECT key, and the `default:` value with its alias list. This file is
// the cross-product, so a producer added later is caught here rather than in
// the next review round.
//
// The rule these all now follow is the one this PR already applied to an
// invalid action and to an invalid rule value: print OUR names (the accepted
// set) and a POSITION, never the caller's text.

import { describe, expect, it } from "vitest";

import { parseAgentArgs } from "../../src/toolkit/agent_cli.js";
import { validatePolicyConfig } from "../../src/toolkit/policy/config.js";
import { validatePluginConfig } from "../../src/connectors/db/lib/plugin_config.js";

/** A bare token: no `key=` shape for a downstream scrub to recognise. */
const TOKEN = "ghp_live_DEADBEEF";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the producer to throw");
}

describe("no producer echoes a caller-supplied name", () => {
  const cases: Array<[string, () => unknown]> = [
    // ── the two reported instances ────────────────────────────────────────
    ["agent_cli: positional", () => parseAgentArgs([TOKEN], { flags: ["action", "params"] })],
    ["agent_cli: unknown flag", () => parseAgentArgs([`--${TOKEN}`, "x"], { flags: ["action", "params"] })],
    ["policy: unknown key", () => validatePolicyConfig({ policy: { [TOKEN]: "allow" } })],

    // ── the shapes found by measuring the class ───────────────────────────
    ["policy: aspect key", () => validatePolicyConfig({ policy: { aspects: { [TOKEN]: 123 } } })],
    ["plugin: unknown policy key", () => validatePluginConfig({ policy: { [TOKEN]: "allow" }, servers: { dev: { driver: "sqlite" } } })],
    ["plugin: server alias, not an object", () => validatePluginConfig({ servers: { [TOKEN]: "x" } })],
    ["plugin: server alias, no driver", () => validatePluginConfig({ servers: { [TOKEN]: {} } })],
    ["plugin: server alias, bad rule", () => validatePluginConfig({ servers: { [TOKEN]: { driver: "sqlite", policy: { read: 123 } } } })],
    ["plugin: server alias, unknown rule key", () => validatePluginConfig({ servers: { [TOKEN]: { driver: "sqlite", policy: { [TOKEN]: "allow" } } } })],
    ["plugin: default not found", () => validatePluginConfig({ default: TOKEN, servers: { dev: { driver: "sqlite" } } })],
  ];

  for (const [name, fn] of cases) {
    it(`${name} — the message never contains the token`, () => {
      const msg = messageOf(fn);
      expect(msg).not.toContain(TOKEN);
      // Not vacuous: a producer that threw an empty message would also pass
      // the assertion above.
      expect(msg.length).toBeGreaterThan(10);
    });
  }

  it("the accepted set survives, because those are our names", () => {
    // The half of each message that is diagnostic. Dropping it too would make
    // the redaction correct and the error useless.
    expect(messageOf(() => parseAgentArgs([TOKEN], { flags: ["action", "params"] }))).toContain(
      "--action, --params",
    );
    expect(
      messageOf(() => validatePolicyConfig({ policy: { [TOKEN]: "allow" } })),
    ).toContain("read, write, admin, aspects");
  });

  it("a position locates the entry the alias no longer names", () => {
    // The replacement for an echoed key: `Object.entries` order is the file's
    // own order, so the index points at the same line the alias did.
    expect(
      messageOf(() =>
        validatePluginConfig({
          servers: { ok: { driver: "sqlite" }, [TOKEN]: "x" },
        }),
      ),
    ).toContain("servers[1]");
    expect(
      messageOf(() =>
        validatePolicyConfig({ policy: { aspects: { fine: "escalate", [TOKEN]: 123 } } }),
      ),
    ).toContain("policy.aspects[1]");
  });
});
