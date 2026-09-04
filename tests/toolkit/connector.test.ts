import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createConnector } from "../../src/toolkit/connector.js";
import type { Decision, ExtendedEnvelope, ResolutionHint } from "../../src/toolkit/policy/types.js";

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "conn-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "conn-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

// Minimal useful connector for happy-path tests.
function makeAws(options: {
  listFunctionsHandler?: (p: unknown) => Promise<unknown>;
  configPath?: string;
} = {}) {
  return createConnector({
    name: "aws-test",
    credentials: async () => ({ region: "us-east-1" }),
    sdk: async () => ({ lambda: { list: (_: unknown) => [{ name: "fn1" }] } }),
    actions: {
      list_functions: {
        params: z.object({
          region: z.string(),
          prefix: z.string().optional(),
        }),
        classify: { kind: "read" },
        handler: options.listFunctionsHandler ?? (async () => ({
          functions: [{ name: "fn1" }],
          count: 1,
        })),
      },
    },
    ...(options.configPath !== undefined ? { policyConfigPath: options.configPath } : {}),
  });
}

describe("createConnector — basic properties", () => {
  it("throws if name is empty", () => {
    expect(() =>
      createConnector({
        name: "",
        credentials: async () => ({}),
        actions: {
          a: {
            params: z.object({}),
            classify: { kind: "read" },
            handler: async () => ({}),
          },
        },
      }),
    ).toThrow(/'name' is required/);
  });

  it("throws if actions is empty", () => {
    expect(() =>
      createConnector({
        name: "x",
        credentials: async () => ({}),
        actions: {},
      }),
    ).toThrow(/at least one action/);
  });

  it("validActions exposes the registry keys", () => {
    const c = makeAws();
    expect([...c.validActions]).toEqual(["list_functions"]);
  });
});

describe("createConnector.fetch — happy paths", () => {
  it("success envelope on valid input", async () => {
    const c = makeAws();
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("success");
    if (env.status === "success") {
      expect(env.action).toBe("list_functions");
      expect(env.data).toEqual({ functions: [{ name: "fn1" }], count: 1 });
    }
  });

  it("handler receives typed params + context", async () => {
    let seenP: unknown;
    let seenCtx: Record<string, unknown> | null = null;
    const c = makeAws({
      listFunctionsHandler: async (p: unknown) => {
        seenP = p;
        seenCtx = { hasSdk: true, hasCreds: true };
        return { ok: true };
      },
    });
    await c.fetch("list_functions", { region: "us-west-2", prefix: "acme-" });
    expect(seenP).toEqual({ region: "us-west-2", prefix: "acme-" });
    expect(seenCtx).not.toBeNull();
  });
});

describe("createConnector.fetch — validation errors", () => {
  it("unknown action returns VALIDATION_ERROR", async () => {
    const c = makeAws();
    const env = await c.fetch("not_a_real_action", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).toContain("Unknown action");
    }
  });

  it("invalid params (missing required) returns VALIDATION_ERROR", async () => {
    const c = makeAws();
    const env = await c.fetch("list_functions", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.retriable).toBe(false);
    }
  });

  it("does not echo a rejected credential from a custom Zod message", async () => {
    // `superRefine` messages are author-controlled prose. This one names the
    // value without any `key = value` shape, so `scrubSecrets` had nothing to
    // key off and redacted only the first word after the colon, leaving
    // `password: "[REDACTED]" value hunter2`. The issue path says the field
    // is a credential, so the whole message is dropped instead.
    const c = createConnector({
      name: "cred-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            password: z.string().superRefine((v, ctx) => {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `rejected value ${v}`,
              });
            }),
          }),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });
    const env = await c.fetch("login", { password: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("password");
    }
  });

  it("keeps the diagnostic message for a non-credential field", async () => {
    // The other half of the trade: dropping every message would make
    // validation errors useless, so only sensitive paths lose theirs.
    const c = makeAws();
    const env = await c.fetch("list_functions", { region: 123 });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("region");
      expect(env.message).not.toBe("region: [REDACTED]");
    }
  });

  it("malformed params type returns VALIDATION_ERROR", async () => {
    const c = makeAws();
    const env = await c.fetch("list_functions", { region: 123 });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
    }
  });

  it("scrubs secrets out of Zod validation messages", async () => {
    // Regression (Codex P2): `safeParse` fails before any of the scrubbed
    // catch blocks, so a schema whose issue text interpolates the rejected
    // value put the secret straight into the envelope `main()` writes to
    // stdout — and into the hardship context recorded alongside it.
    const c = createConnector({
      name: "scrub-test",
      credentials: async () => ({}),
      actions: {
        login: {
          params: z
            .object({ password: z.string() })
            .superRefine((v, ctx) => {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `rejected password="${v.password}"`,
              });
            }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { password: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("handler throwing a foreign ZodError-shaped object still maps to VALIDATION_ERROR", async () => {
    // Simulates a consumer whose zod install is a separate module instance
    // from the toolkit's (e.g. via `file:` deps) — `instanceof z.ZodError`
    // returns false, so the structural check must catch it.
    const foreignZodError = Object.assign(new Error("invalid input"), {
      name: "ZodError",
      issues: [{ path: ["sql"], message: "required" }],
    });
    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          description: "",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw foreignZodError;
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).toContain("sql: required");
    }
  });
});

describe("createConnector.fetch — secret redaction in error messages", () => {
  // The zod-validation branch of run() builds its ErrorEnvelope inline and
  // never reaches the scrub in mapAndBuildError, so the redaction has to sit
  // inside defaultErrorMap itself.
  function makeDsnConnector() {
    return createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        connect: {
          params: z.object({
            dsn: z.string().refine((v) => v.startsWith("safe://"), (v) => ({
              message: `unsupported dsn: ${v}`,
            })),
          }),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });
  }

  it("redacts a credential echoed back by a zod issue message", async () => {
    const c = makeDsnConnector();
    const env = await c.fetch("connect", {
      dsn: 'postgres://u@h/db?password="hunter2"',
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("[REDACTED]");
      // The non-sensitive part of the issue must survive, or the envelope
      // stops being actionable.
      expect(env.message).toContain("unsupported dsn");
    }
  });

  it("redacts a root-level issue whose prose names a credential", async () => {
    // An issue raised on the object rather than on one of its fields has an
    // empty path, so the `isSensitiveFieldPath` test is blind to it. The
    // message here is prose with no `key = value` shape either, so
    // `scrubSecrets` cannot find the credential — both existing defences miss
    // it and `hunter2` reached the envelope verbatim.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z
            .object({ user: z.string(), password: z.string() })
            .superRefine((v, ctx) => {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `rejected password ${v.password}`,
              });
            }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { user: "alice", password: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("<root>: [REDACTED]");
    }
  });

  it("redacts a root-level custom issue even when the prose names no field", async () => {
    // `custom` is the only zod code that places no constraint on message
    // content, so a pathless custom message is dropped on the code alone —
    // there is no vocabulary to key off here, and the value is still the
    // input.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z
            .object({ secret_value: z.string() })
            .superRefine((v, ctx) => {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `the value ${v.secret_value} is not acceptable`,
              });
            }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { secret_value: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("the value [REDACTED] is not acceptable");
    }
  });

  it("keeps a root-level message zod generated itself", async () => {
    // The guard against over-correcting: zod's own root messages are
    // templated from the schema, never from the input, and blanking them
    // would leave the caller with `<root>: [REDACTED]` for an ordinary type
    // mismatch. A foreign ZodError-shaped object is used because the toolkit
    // parses params before a real zod root type error can surface here.
    const foreignZodError = Object.assign(new Error("invalid input"), {
      name: "ZodError",
      issues: [
        {
          path: [],
          code: "invalid_type",
          message: "Expected object, received string",
        },
      ],
    });
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw foreignZodError;
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).toContain("<root>: Expected object, received string");
    }
  });

  it("still redacts a non-custom root issue whose message names a credential", async () => {
    // The complement of the test above: same pathless shape, same non-custom
    // code, but the prose names the field — so the message goes.
    const foreignZodError = Object.assign(new Error("invalid input"), {
      name: "ZodError",
      issues: [
        {
          path: [],
          code: "too_small",
          message: "api_key hunter2 is too short",
        },
      ],
    });
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw foreignZodError;
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("<root>: [REDACTED]");
    }
  });

  it("redacts a custom issue raised at a nested, non-sensitive path", async () => {
    // The path is `credentials`, which is not itself a credential name, so the
    // path test does not fire — and the prose has no `key = value` shape for
    // `scrubSecrets` either. Only the input-echo rule catches this, and it has
    // to work at every depth, not only at the root.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            credentials: z
              .object({ user: z.string(), pw: z.string() })
              .superRefine((v, ctx) => {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `rejected value ${v.pw}`,
                });
              }),
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", {
      credentials: { user: "alice", pw: "hunter2" },
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      // Redacted in place, so the author's own words survive and only the
      // caller's input goes. Dropping the whole message here was the earlier
      // behaviour and it took the diagnostic with it.
      expect(env.message).toContain("credentials: rejected value [REDACTED]");
    }
  });

  it("keeps a constant refinement message that never touches the input", async () => {
    // The guard against over-correcting, and the reason the rule keys on the
    // input rather than on `code === "custom"`. Every object-level `.refine`
    // emits a root-path custom issue, so a code-based test blanked static
    // diagnostics too — `src/connectors/gcp/index.ts`'s `query_logs` schema
    // lost the instruction saying exactly one filter is required.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        query: {
          params: z
            .object({ filter: z.string().optional(), query: z.string().optional() })
            .refine((v) => (v.filter === undefined) !== (v.query === undefined), {
              message: "exactly one of filter or query is required",
            }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("query", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("exactly one of filter or query is required");
    }
  });

  it("keeps the useful half when the scrubber can find the credential", async () => {
    // The input-echo rule defers to `scrubSecrets`: when the echoed value has
    // a `key = value` shape the scrubber can key on, only the secret goes and
    // the diagnostic survives. Dropping the whole message is reserved for
    // prose the scrubber provably cannot clean.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        connect: {
          params: z.object({
            dsn: z.string().refine((v) => v.startsWith("safe://"), (v) => ({
              message: `unsupported dsn: ${v}`,
            })),
          }),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });
    const env = await c.fetch("connect", {
      dsn: 'postgres://u@h/db?password="hunter2"',
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("unsupported dsn");
    }
  });

  it("leaves diagnostics intact when a parameter is the empty string", async () => {
    // `""` cannot expose anything, and in the whole-token branch it compiled
    // to a zero-length pattern matching at every boundary — one empty
    // parameter turned `Invalid option: use --filter.` into
    // `Invalid option:[REDACTED] use [REDACTED]-[REDACTED]-filter.[REDACTED]`.
    const c = createConnector<{}>({
      name: "empty-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ q: z.string() }).superRefine((_v, ctx) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Invalid option: use --filter.",
            });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { q: "" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("<root>: Invalid option: use --filter.");
    }
  });

  it("redacts a credential a transform rewrote before the refinement saw it", async () => {
    // `superRefine` runs after `transform`, so the string the message names is
    // not the string in params. At a non-sensitive path nothing else caught it.
    for (const transform of [
      (v: string) => v.trim(),
      (v: string) => v.toUpperCase(),
      (v: string) => v.trim().slice(0, 7),
    ]) {
      const c = createConnector<{}>({
        name: "transform-test",
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.object({
              profile: z.object({
                nickname: z
                  .string()
                  .transform(transform)
                  .superRefine((v, ctx) => {
                    ctx.addIssue({
                      code: z.ZodIssueCode.custom,
                      message: `rejected value ${v}`,
                    });
                  }),
              }),
            }),
            classify: { kind: "read" },
            handler: async () => ({}),
          },
        },
      });
      const env = await c.fetch("login", { profile: { nickname: "  hunter2  " } });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message.toLowerCase()).not.toContain("hunter2");
      }
    }
  });

  it("formats a large validation failure in linear time", async () => {
    // One issue per rejected element against one candidate per element is a
    // cross-product, and the node bound did not reach it: 8k elements measured
    // 134ms against 35ms for 4k. Doubling the input must not quadruple the
    // time. Ratios rather than absolute times, so this is not a CI-speed test.
    const time = async (n: number): Promise<number> => {
      const ids = Array.from({ length: n }, (_, i) => `value-number-${i}-abcdefghijklmnop`);
      const c = createConnector<{}>({
        name: "wide-test",
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.object({ ids: z.array(z.string()) }).superRefine((v, ctx) => {
              for (let i = 0; i < v.ids.length; i++) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["ids", i],
                  message: `bad element ${i}`,
                });
              }
            }),
            classify: { kind: "read" },
            handler: async () => ({}),
          },
        },
      });
      const t = Date.now();
      await c.fetch("login", { ids });
      return Date.now() - t;
    };
    await time(1000); // warm up the JIT so the ratio measures the algorithm
    const small = await time(2000);
    const large = await time(8000);
    // 4x the input. Linear predicts ~4x, quadratic ~16x. A threshold of 8
    // separates them with room for noise; the pre-fix code measured ~13x.
    expect(large).toBeLessThan(Math.max(small, 1) * 8);
  }, 120_000);

  it("redacts a one-character echoed credential", async () => {
    // The length rule used to EXCLUDE short values, so a one-character
    // credential at a non-sensitive path was neither dropped by the path
    // check nor found by `scrubSecrets`, and reached the envelope intact.
    const c = createConnector<{}>({
      name: "one-char-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            credentials: z
              .object({ password: z.string() })
              .superRefine((v, ctx) => {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `rejected value ${v.password}`,
                });
              }),
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { credentials: { password: "x" } });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("credentials: rejected value [REDACTED]");
    }
  });

  it("does not shred a diagnostic that merely contains a short input", async () => {
    // The other half of the same rule, and the reason the short value cannot
    // simply join the substring pass. With `name: "a"` in params, redacting
    // every "a" would render `Invalid parameter supplied` unreadable. A short
    // value counts only where it stands as a whole token.
    const c = createConnector<{}>({
      name: "short-noise-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z
            .object({ name: z.string() })
            .superRefine((_v, ctx) => {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid parameter supplied",
              });
            }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { name: "a" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("<root>: Invalid parameter supplied");
    }
  });

  it("redacts a punctuation-only echoed value at a token boundary", async () => {
    // `\\b` cannot anchor a punctuation-only value, which is why the boundary
    // is expressed as non-word neighbours instead.
    const c = createConnector<{}>({
      name: "punct-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            credentials: z
              .object({ password: z.string() })
              .superRefine((v, ctx) => {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `rejected value ${v.password} here`,
                });
              }),
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { credentials: { password: "-" } });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("credentials: rejected value [REDACTED] here");
    }
  });

  it("survives a deeply nested params tree without exhausting the stack", async () => {
    // The node bound limits total work, not nesting, and the two are
    // independent: a few thousand nested arrays blew the call stack long
    // before 50k nodes were visited, turning a validation failure into a
    // RangeError escaping as a crash rather than an error envelope.
    let deep: unknown = "hunter2";
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const c = createConnector<{}>({
      name: "deep-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any().superRefine((_v, ctx) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "rejected value hunter2",
            });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", deep);
    // The point is that this returns an envelope at all rather than throwing.
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).not.toContain("hunter2");
    }
  });

  it("fails closed when the input walk hits its node bound", async () => {
    // Past the bound the collected set is partial, and a partial set is
    // indistinguishable from a complete one — so redacting against it would
    // report success while leaking. The message is dropped; the path stays.
    const wide: Record<string, unknown> = { password: "hunter2" };
    for (let i = 0; i < 60_000; i++) wide[`f${i}`] = i;
    const c = createConnector<{}>({
      name: "bound-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any().superRefine((_v, ctx) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "rejected value hunter2",
            });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", wide);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("redacts a two-character echoed credential", async () => {
    // The old rule ignored input strings under three characters, on the
    // assumption that something that short is not a credential. It is not a
    // safe assumption, and in-place redaction makes the cutoff cheap enough
    // that it does not need to be made: `pw: "xy"` at a non-sensitive parent
    // path leaked as `credentials: rejected value xy`.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            credentials: z
              .object({ user: z.string(), pw: z.string() })
              .superRefine((v, ctx) => {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `rejected value ${v.pw}`,
                });
              }),
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { credentials: { user: "alice", pw: "xy" } });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("credentials: rejected value [REDACTED]");
    }
  });

  it("collects a credential nested deeper than the old depth cap", async () => {
    // The collector had a depth cap of 6, standing in for "do not loop forever
    // on a cyclic object". It paid for that with silence: anything deeper
    // never entered the set, and nothing could tell that from "no credential
    // present".
    let inner: z.ZodTypeAny = z.object({ pw: z.string() });
    for (let i = 0; i < 7; i++) inner = z.object({ n: inner });
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ deep: inner }).superRefine((v, ctx) => {
            let x = v.deep as Record<string, unknown>;
            while (x["n"] !== undefined) x = x["n"] as Record<string, unknown>;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `rejected value ${String(x["pw"])}`,
              path: ["deep"],
            });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    let payload: unknown = { pw: "hunter2" };
    for (let i = 0; i < 7; i++) payload = { n: payload };
    const env = await c.fetch("login", { deep: payload });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("deep: rejected value [REDACTED]");
    }
  });

  it("terminates on cyclic params", async () => {
    // The reason the depth cap existed. A `seen` set stops the cycle for that
    // reason directly, instead of guessing a depth that also truncates
    // legitimate nesting.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any().superRefine((_v, ctx) => {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rejected value hunter2" });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const cyclic: Record<string, unknown> = { pw: "hunter2" };
    cyclic["self"] = cyclic;
    cyclic["arr"] = [cyclic, { b: cyclic }];
    const env = await c.fetch("login", cyclic);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
    }
  });

  it("redacts a numeric credential echoed by a nested issue", async () => {
    // The echo collector only walked strings, so a numeric PIN was outside
    // the defence entirely — the parent path is not sensitive and
    // `scrubSecrets` has no `key = value` shape to find in the prose. A
    // credential is not always a string.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            credentials: z
              .object({ password: z.number() })
              .superRefine((v, ctx) => {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `rejected value ${v.password}`,
                });
              }),
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { credentials: { password: 123456 } });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("credentials: rejected value [REDACTED]");
    }
  });

  it("keeps a constant diagnostic that merely contains an input string", async () => {
    // The other end of the same dial, and the reason it stopped being a dial.
    // `filter: "query_logs"` occurs inside the schema's own static message, so
    // a boolean substring test read the constant diagnostic as an echo and
    // blanked it. Redacting in place removes the echoed token and leaves the
    // instruction the caller needs.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        query: {
          params: z
            .object({
              filter: z.string().optional(),
              structured_filter: z.string().optional(),
            })
            .refine(
              (v) => (v.filter === undefined) !== (v.structured_filter === undefined),
              { message: "exactly one of filter or structured_filter is required for query_logs" },
            ),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("query", {
      filter: "query_logs",
      structured_filter: "x",
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("exactly one of filter or structured_filter is required");
    }
  });

  it("redacts a credential in a thrown handler error", async () => {
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error('upstream rejected api_key="sk-live-abc123"');
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("sk-live-abc123");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("classifies on the raw message, so a secret cannot steer error_code", async () => {
    // "timeout" appears only inside the redacted value. Scrubbing before the
    // heuristic would misclassify this as CONNECTION_ERROR.
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error('upstream failed: token="timeout-sentinel"');
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("TIMEOUT");
      expect(env.message).not.toContain("timeout-sentinel");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("leaves an error with no credential material untouched", async () => {
    const c = createConnector<{}>({
      name: "redact-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("ECONNREFUSED 127.0.0.1:5432");
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONNECTION_ERROR");
      expect(env.message).toBe("ECONNREFUSED 127.0.0.1:5432");
    }
  });
});

describe("createConnector.fetch — policy gate", () => {
  function writeConfig(name: string, yaml: string): string {
    const configPath = path.join(tmpCwd, "custom.yaml");
    fs.writeFileSync(configPath, yaml);
    return configPath;
  }

  it("denied rule returns a denied envelope, handler not called", async () => {
    const configPath = writeConfig("aws", "policy:\n  read: denied\n");
    let handlerCalled = false;
    const c = makeAws({
      configPath,
      listFunctionsHandler: async () => {
        handlerCalled = true;
        return {};
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("denied");
    expect(handlerCalled).toBe(false);
  });

  it("escalate on approval_mode=confirm_each + read=success", async () => {
    const configPath = writeConfig(
      "aws",
      "policy:\n  read: success\napproval_mode: confirm_each\n",
    );
    const c = makeAws({ configPath });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("escalate");
  });

  it("invalid config surfaces as CONFIG_ERROR envelope", async () => {
    const configPath = path.join(tmpCwd, "bad.yaml");
    fs.writeFileSync(configPath, "policy:\n  admin: success\n"); // safety floor breach
    const c = makeAws({ configPath });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).toContain("safety floor");
    }
  });
});

describe("createConnector.fetch — runtime errors", () => {
  it("handler throw maps to CONNECTION_ERROR by default", async () => {
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error("ECONNRESET: peer closed");
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONNECTION_ERROR");
      expect(env.retriable).toBe(true);
    }
  });

  it("handler 401 message maps to AUTH_ERROR", async () => {
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error("401 Unauthorized");
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    if (env.status === "error") {
      expect(env.error_code).toBe("AUTH_ERROR");
      expect(env.retriable).toBe(false);
    }
  });

  it("handler 429 maps to RATE_LIMITED with retriable=true", async () => {
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    if (env.status === "error") {
      expect(env.error_code).toBe("RATE_LIMITED");
      expect(env.retriable).toBe(true);
    }
  });

  it("mapError hook overrides default mapping", async () => {
    const c = createConnector({
      name: "aws-test",
      credentials: async () => ({}),
      actions: {
        list_functions: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("custom-service-specific");
          },
        },
      },
      mapError: () => ({ error_code: "CONFIG_ERROR", message: "override", retriable: false }),
    });
    const env = await c.fetch("list_functions", {});
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).toBe("override");
    }
  });

  it("redacts credentials in the handler-throw error envelope", async () => {
    // Regression (Codex P1): classify()/extendDecision()/arg-parsing were
    // scrubbed but mapAndBuildError returned `message` verbatim, so the
    // primary runtime error path still wrote secrets to the stdout envelope.
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error(`connect failed: password="hunter2"`);
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("redacts credentials surfaced through a mapError override", async () => {
    // A connector's custom mapper commonly interpolates the raw driver error.
    const c = createConnector({
      name: "aws-test",
      credentials: async () => ({}),
      actions: {
        list_functions: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error(`api_key='sk-live-abc123'`);
          },
        },
      },
      mapError: (err) => ({
        error_code: "CONFIG_ERROR",
        message: `driver: ${(err as Error).message}`,
        retriable: false,
      }),
    });
    const env = await c.fetch("list_functions", {});
    if (env.status === "error") {
      expect(env.message).not.toContain("sk-live-abc123");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("redacts credentials surfaced through the policy-config load error", async () => {
    // The remaining unscrubbed exposure path: `loadPolicyConfig` validation
    // errors echo the offending value (`validateRule` interpolates it via
    // JSON.stringify), and `policyLoadError` reaches the CONFIG_ERROR envelope
    // that `main()` writes to stdout.
    const cfgPath = path.join(tmpCwd, "policy.yaml");
    fs.writeFileSync(
      cfgPath,
      'policy:\n  read: "postgres://admin:hunter2@db.internal:5432/app"\n',
      "utf-8",
    );
    const c = makeAws({ configPath: cfgPath });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("[REDACTED]");
    }
  });
});

describe("createConnector.fetch — extendDecision hook", () => {
  it("extendDecision can attach a custom status + fields (db-agent's present_only pattern)", async () => {
    const c = createConnector({
      name: "db-test",
      credentials: async () => ({}),
      actions: {
        query: {
          params: z.object({ sql: z.string() }),
          classify: { kind: "write" }, // triggers default policy.write = present
          handler: async () => ({ rows: [] }),
        },
      },
      extendDecision: (decision: Decision, ctx): Decision | ExtendedEnvelope => {
        if (decision.status === "escalate") {
          return {
            status: "present_only",
            action: ctx.action,
            reason: decision.reason,
            formatted_sql: `-- formatted: ${(ctx.params as { sql: string }).sql}`,
          };
        }
        return decision;
      },
    });
    const env = await c.fetch("query", { sql: "DELETE FROM users" });
    expect(env.status).toBe("present_only");
    const ext = env as Record<string, unknown>;
    expect(ext.formatted_sql).toContain("DELETE");
  });
});

describe("createConnector.main — CLI behavior", () => {
  it("--action + --params emits success envelope to stdout", async () => {
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main([
        "--action", "list_functions",
        "--params", JSON.stringify({ region: "us-east-1" }),
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join("").trim());
      expect(parsed.status).toBe("success");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("malformed --params JSON exits 2", async () => {
    const c = makeAws();
    const origErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main(["--action", "list_functions", "--params", "not json"]);
      expect(code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("missing --action exits 2", async () => {
    const c = makeAws();
    const origErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main([]);
      expect(code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("denied envelope exits with code 1", async () => {
    const configPath = path.join(tmpCwd, "custom.yaml");
    fs.writeFileSync(configPath, "policy:\n  read: denied\n");
    const c = makeAws({ configPath });
    const origOut = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await c.main([
        "--action", "list_functions",
        "--params", JSON.stringify({ region: "us-east-1" }),
      ]);
      expect(code).toBe(1);
    } finally {
      process.stdout.write = origOut;
    }
  });

  it("--help prints usage and exits 0", async () => {
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--help"]);
      expect(code).toBe(0);
      const out = writes.join("");
      expect(out).toContain("Usage:");
      expect(out).toContain("list_functions");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--version prints version and exits 0", async () => {
    const c = createConnector({
      name: "aws-test",
      version: "9.9.9",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--version"]);
      expect(code).toBe(0);
      expect(writes.join("")).toContain("9.9.9");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--curate outputs JSON snapshot and exits 0", async () => {
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--curate"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join("").trim());
      expect(parsed.connector).toBe("aws-test");
      expect(parsed).toHaveProperty("clusters");
      expect(parsed).toHaveProperty("marker");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("unknown flag exits 2", async () => {
    const c = makeAws();
    const origErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main(["--unknown-flag"]);
      expect(code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });
});

describe("createConnector — extendDecision path on base success", () => {
  it("extendDecision receiving success decision does not modify envelope", async () => {
    let seen: unknown;
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
      extendDecision: (decision) => {
        seen = decision.status;
        return decision; // no modification
      },
    });
    const env = await c.fetch("a", {});
    expect(seen).toBe("success");
    expect(env.status).toBe("success");
  });

  it("extendDecision throwing returns CONFIG_ERROR envelope", async () => {
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
      extendDecision: () => {
        throw new Error("hook broke");
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).toContain("extendDecision");
    }
  });
});

describe("createConnector — EnvelopeOverride escape hatch", () => {
  it("handler throwing EnvelopeOverride emits the carried envelope verbatim", async () => {
    const { EnvelopeOverride } = await import("../../src/toolkit/connector.js");
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new EnvelopeOverride({
              status: "present_only",
              reason: "DML displayed but not executed",
              formatted_sql: "DELETE FROM users",
              execution_time_ms: 0.5,
            });
          },
        },
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("present_only");
    const extended = env as Record<string, unknown>;
    expect(extended.action).toBe("a");
    expect(extended.formatted_sql).toBe("DELETE FROM users");
    expect(extended.reason).toBe("DML displayed but not executed");
  });

  it("EnvelopeOverride with denied status emits a denied envelope", async () => {
    const { EnvelopeOverride } = await import("../../src/toolkit/connector.js");
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new EnvelopeOverride({
              status: "denied",
              reason: "custom reason",
              execution_time_ms: 1.2,
            });
          },
        },
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("denied");
    const extended = env as Record<string, unknown>;
    expect(extended.reason).toBe("custom reason");
    expect(extended.execution_time_ms).toBe(1.2);
  });
});

describe("createConnector — dynamic classify", () => {
  it("classify function on action spec is called with validated params", async () => {
    let seenP: unknown = null;
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({ danger: z.boolean() }),
          classify: (p): { kind: "read" | "write" | "admin" } => {
            seenP = p;
            return p.danger ? { kind: "admin" } : { kind: "read" };
          },
          handler: async () => ({ ok: true }),
        },
      },
    });
    const danger = await c.fetch("a", { danger: true });
    expect(seenP).toEqual({ danger: true });
    expect(danger.status).toBe("denied"); // default admin=denied
    const safe = await c.fetch("a", { danger: false });
    expect(safe.status).toBe("success");
  });

  it("factory-level classify hook wins over action spec classify", async () => {
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" }, // would be success
          handler: async () => ({ ok: true }),
        },
      },
      classify: () => ({ kind: "admin" }), // override — becomes denied
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("denied");
  });

  it("classify throwing returns CONFIG_ERROR envelope", async () => {
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: () => {
            throw new Error("classify broke");
          },
          handler: async () => ({ ok: true }),
        },
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
    }
  });
});

describe("ExtendedEnvelope + ResolutionHint shape (3.0)", () => {
  it("ExtendedEnvelope accepts a string status and extension blob", () => {
    const env: ExtendedEnvelope = {
      status: "present",
      action: "run_query",
      message: "rows present but redacted",
      extension: { rows: [], redacted_columns: ["ssn"] },
    };
    expect(env.status).toBe("present");
    expect(env.extension).toBeDefined();
  });

  it("ResolutionHint has pattern_id, advice, confidence, scope", () => {
    const hint: ResolutionHint = {
      pattern_id: "jira-archived-404",
      advice: "Check archived flag",
      confidence: 0.9,
      scope: "tenant",
    };
    expect(hint.confidence).toBeGreaterThan(0);
  });
});

describe("ConnectorConfig.scope (3.0)", () => {
  it("passes the scope-fn return value to the hardship recorder", async () => {
    const recorded: unknown[] = [];
    const hardshipStub = (e: unknown) => { recorded.push(e); };

    const c = createConnector<{ siteUrl: string }>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({ siteUrl: "https://acme" }),
      scope: (ctx) => ctx.sdk.siteUrl,
      actions: {
        fail_please: {
          description: "always throws",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("oh no");
          },
        },
      },
      hardship: {
        enabled: true,
        recorder: hardshipStub as typeof hardshipStub,
      },
    });

    await c.fetch("fail_please", {});
    expect(recorded.length).toBeGreaterThan(0);
    const entry = recorded[0] as { scope?: string };
    expect(entry.scope).toBe("https://acme");
  });

  it("uses null scope when config.scope is absent", async () => {
    const recorded: unknown[] = [];
    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        fail_please: {
          description: "always throws",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("no scope");
          },
        },
      },
      hardship: {
        enabled: true,
        recorder: (e: unknown) => recorded.push(e),
      },
    });

    await c.fetch("fail_please", {});
    const entry = recorded[0] as { scope?: string | null };
    expect(entry.scope).toBeNull();
  });
});

describe("envelope resolution_hint", () => {
  it("attaches a matching pattern's hint to the error envelope", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "conn-hint-"));
    const cwd = path.join(tmp, "proj");
    await fsp.mkdir(
      path.join(cwd, ".claude/connectors/testconn/global"),
      { recursive: true },
    );
    await fsp.writeFile(
      path.join(cwd, ".claude/connectors/testconn/global/patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: generic-404
    status: active
    confidence: 0.9
    kind: not_found
    matcher: { context_regex: "HTTP 404" }
    advice: "double-check the resource id"
`,
    );

    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      runtime: { cwd, home: tmp },
      actions: {
        get_404: {
          description: "always 404",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("HTTP 404 from upstream");
          },
        },
      },
      mapError: () => ({
        error_code: "NOT_FOUND",
        message: "HTTP 404 from upstream",
        retriable: false,
      }),
    });

    const r = await c.fetch("get_404", {});
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.resolution_hint?.pattern_id).toBe("generic-404");
      expect(r.resolution_hint?.scope).toBe("global");
      expect(r.resolution_hint?.advice).toBe("double-check the resource id");
    }

    await fsp.rm(tmp, { recursive: true });
  });

  it("envelope has no resolution_hint when no pattern matches", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "conn-nohint-"));
    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      runtime: { cwd: tmp, home: tmp },
      actions: {
        get_x: {
          description: "fail",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => { throw new Error("timeout"); },
        },
      },
      mapError: () => ({
        error_code: "TIMEOUT",
        message: "timeout",
        retriable: true,
      }),
    });

    const r = await c.fetch("get_x", {});
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.resolution_hint).toBeUndefined();
    }

    await fsp.rm(tmp, { recursive: true });
  });
});

describe("connector.recordResolution", () => {
  it("appends a resolution entry using the last action's scope", async () => {
    const recorded: unknown[] = [];
    const c = createConnector<{ siteUrl: string }>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({ siteUrl: "https://acme" }),
      scope: (ctx) => ctx.sdk.siteUrl,
      hardship: {
        enabled: true,
        recorder: (e) => recorded.push(e),
      },
      actions: {
        noop: {
          description: "",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });

    await c.fetch("noop", {});
    c.recordResolution({
      pattern_id: "some-id",
      advice: "cast to number first",
    });

    const r = recorded.find(
      (e) => (e as { kind: string }).kind === "resolution",
    ) as { resolution: string; scope: string | null; action: string };
    expect(r.resolution).toBe("cast to number first");
    expect(r.scope).toBe("https://acme");
    expect(r.action).toBe("noop");
  });

  it("allows explicit scope override", async () => {
    const recorded: unknown[] = [];
    const c = createConnector<{ siteUrl: string }>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({ siteUrl: "https://acme" }),
      scope: (ctx) => ctx.sdk.siteUrl,
      hardship: {
        enabled: true,
        recorder: (e) => recorded.push(e),
      },
      actions: {
        noop: {
          description: "",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });

    await c.fetch("noop", {});
    c.recordResolution({
      pattern_id: "some-id",
      advice: "X",
      scope: "https://beta",
      action: "noop",
    });

    const r = recorded.find(
      (e) => (e as { kind: string }).kind === "resolution",
    ) as { scope: string | null };
    expect(r.scope).toBe("https://beta");
  });
});
