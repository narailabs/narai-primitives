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

  it("unknown action does not echo a credential shaped into the action name", async () => {
    // This is the ONE validation path that returns before `params` and
    // `credentials` are resolved, so `redactSensitiveEchoes` has nothing to
    // compare against and `scrubSecrets` is the only defence. A shell mistake
    // (`--action "$API_KEY"`) puts the credential straight into an envelope
    // that `main` writes to stdout and the audit writer records.
    const c = makeAws();
    const env = await c.fetch("api_key=sk-live-DEADBEEF", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).not.toContain("sk-live-DEADBEEF");
      expect(env.message).toContain("[REDACTED]");
      // The valid half survives: `validActions` is a static identifier list,
      // so scrubbing the whole message still leaves the actionable part.
      expect(env.message).toContain("list_functions");
    }
  });

  it("a non-enumerable credential property is still a redaction candidate", async () => {
    // Enumerability is a display flag, not access control. A `credentials()`
    // loader that hides `token` behind `enumerable: false` still hands it to
    // the handler, and the walk reported a COMPLETE candidate set while
    // silently skipping it — worse than failing closed, because the caller
    // was told redaction had everything it needed.
    const creds: Record<string, unknown> = { region: "us-east-1" };
    Object.defineProperty(creds, "token", {
      value: "NONENUM-SECRET-7",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const c = createConnector({
      name: "nonenum-test",
      credentials: async () => creds,
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected NONENUM-SECRET-7");
          },
        },
      },
    });
    const env = await c.fetch("go", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("NONENUM-SECRET-7");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("an accessor on the credential object still fails closed", async () => {
    // The non-enumerable fix must not become a licence to invoke getters:
    // that would run caller code inside the redaction path.
    const creds: Record<string, unknown> = { region: "us-east-1" };
    Object.defineProperty(creds, "token", {
      get: () => "GETTER-SECRET",
      enumerable: true,
      configurable: true,
    });
    const c = createConnector({
      name: "getter-test",
      credentials: async () => creds,
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected GETTER-SECRET");
          },
        },
      },
    });
    const env = await c.fetch("go", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("GETTER-SECRET");
    }
  });

  it("a sensitive path is dropped even when an input value mangles it", async () => {
    // `redactEchoedInput` rewrites any span matching an input value —
    // including a span INSIDE the field name. With `{mode: "pass"}` the path
    // `password` displays as `[REDACTED]word`, and asking
    // `isSensitiveFieldPath` about THAT string answered no. The message named
    // a RESOLVED credential that was never in the raw input, so `echoesInput`
    // could not catch it either, and it reached stdout.
    const VAULT: Record<string, string> = { API_PASSWORD: "RESOLVED-SECRET-42" };
    const mk = () =>
      createConnector({
        name: "path-test",
        credentials: async () => ({ region: "us-east-1" }),
        sdk: async () => ({}),
        actions: {
          go: {
            params: z
              .object({ mode: z.string(), password: z.string() })
              .superRefine((v, ctx) => {
                const resolved = v.password.startsWith("env:")
                  ? VAULT[v.password.slice(4)]
                  : v.password;
                ctx.addIssue({
                  code: "custom",
                  path: ["password"],
                  message: `upstream rejected ${resolved}`,
                });
              }),
            classify: { kind: "read" },
            handler: async () => ({}),
          },
        },
      });
    // The leaking case: `mode` is a substring of `password`.
    const bad = await mk().fetch("go", { mode: "pass", password: "env:API_PASSWORD" });
    expect(JSON.stringify(bad)).not.toContain("RESOLVED-SECRET-42");
    // Control: no substring collision, and it was already correct.
    const ok = await mk().fetch("go", { mode: "normal", password: "env:API_PASSWORD" });
    expect(JSON.stringify(ok)).not.toContain("RESOLVED-SECRET-42");
  });

  it("unknown action scrubs the action FIELD, not only the message", async () => {
    // `main` serializes the WHOLE envelope to stdout. Scrubbing `message`
    // while leaving `action` moves the credential one key to the left.
    const c = makeAws();
    const env = await c.fetch("api_key=sk-live-DEADBEEF", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(JSON.stringify(env)).not.toContain("sk-live-DEADBEEF");
      expect(env.action).toBe("[REDACTED]");
      expect(env.message).toContain("list_functions");
    }
  });

  it("a handler mutating PARAMS cannot erase the candidate set either", async () => {
    // The sibling of the credentials case, one argument to the left. An
    // identity schema (`z.any()`) hands the caller's own object to the
    // handler, so `validated` and `params` are the same mutable thing —
    // snapshotting credentials alone left this open.
    const c = createConnector({
      name: "mutating-params",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async (p) => {
            const rec = p as Record<string, string>;
            const old = rec.token;
            delete rec.token;
            throw new Error(`rejected ${old}`);
          },
        },
      },
    });
    const env = await c.fetch("go", { token: "PARAM-SECRET-55" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("PARAM-SECRET-55");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("a credential used as an unrecognized KEY is redacted", async () => {
    // zod echoes the offending key: `Unrecognized key(s) in object: 'X'`.
    // The value contributes no candidate and no shape-based scrub sees a bare
    // token. Only the keys the SCHEMA REJECTED are collected — see the
    // comment at that call site for why every key is the wrong set.
    // `.strict()` on purpose: a plain `z.object` STRIPS unknown keys and
    // never reports them, so only a strict schema reaches this path.
    const c = createConnector({
      name: "strict-keys",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({ a: z.string().optional() }).strict(),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("go", { ghp_live_DEADBEEF: true } as never);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("ghp_live_DEADBEEF");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("a schema field name is NOT redacted out of its own diagnostic", async () => {
    // The control for the rule above, and the reason it is scoped to
    // rejected keys: collecting every key redacts the field PATH, so the
    // caller stops learning which field failed.
    const c = makeAws();
    const env = await c.fetch("list_functions", { region: 5 } as never);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("region");
      expect(env.message).not.toContain("[REDACTED]");
    }
  });

  it("a handler mutating ctx.credentials cannot erase the candidate set", async () => {
    // `ctx.credentials` is the handler's to mutate — rotating a token,
    // deleting a consumed one. Candidates were collected at redaction time,
    // i.e. AFTER the handler ran, so reading `ctx.credentials.token`,
    // deleting it, then throwing produced an empty set and the old value went
    // out in the envelope and the hardship context. The snapshot is taken
    // before the object is handed over.
    const c = createConnector({
      name: "mutating-handler",
      credentials: async () => ({ region: "us-east-1", token: "OLD-TOKEN-77" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async (_p, ctx) => {
            const old = (ctx.credentials as Record<string, string>).token;
            delete (ctx.credentials as Record<string, string>).token;
            throw new Error(`rejected ${old}`);
          },
        },
      },
    });
    const env = await c.fetch("go", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("OLD-TOKEN-77");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("a service-prefixed credential param is a redaction candidate", async () => {
    for (const key of ["github_token", "githubToken", "db_password", "userApiKey"]) {
      const c = createConnector({
        name: `svc-${key}`,
        credentials: async () => ({ region: "us-east-1" }),
        sdk: async () => ({}),
        actions: {
          go: {
            params: z.object({ [key]: z.string() }) as never,
            classify: { kind: "read" },
            handler: async () => {
              throw new Error("rejected hunter2");
            },
          },
        },
      });
      const env = await c.fetch("go", { [key]: "hunter2" });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message, key).not.toContain("hunter2");
      }
    }
  });

  it("a candidate matches its SERIALIZED spelling, not only the raw one", async () => {
    // Codex P1. A handler rarely interpolates a value raw. With a password of
    // `abc"def`, `JSON.stringify({error: pw})` emits `abc\"def`, which no
    // candidate matched, and scrubSecrets leaves a generic `error` key alone —
    // so parsing the returned envelope handed the credential straight back.
    // The single-quote form is the same bug in a Python repr.
    const secret = 'abc"def';
    const renders: Array<[string, (v: string) => string]> = [
      ["raw", (v) => `upstream rejected ${v}`],
      ["JSON", (v) => `payload ${JSON.stringify({ error: v })}`],
      ["escaped quote", (v) => `got ${v.replace(/"/g, '\\"')}`],
    ];
    for (const [label, render] of renders) {
      const c = createConnector({
        name: `esc-${label.replace(/\s/g, "-")}`,
        credentials: async () => ({ region: "us-east-1" }),
        sdk: async () => ({}),
        actions: {
          go: {
            params: z.object({ password: z.string() }),
            classify: { kind: "read" },
            handler: async () => {
              throw new Error(render(secret));
            },
          },
        },
      });
      const env = await c.fetch("go", { password: secret });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message, label).not.toContain("abc");
        expect(env.message, label).not.toContain("def");
      }
    }
  });

  it("a CALLABLE carrying own data properties is walked, not skipped", async () => {
    // Codex P1. `typeof v !== "object"` skipped a function, and a function
    // carries own data properties like anything else. The walk reported a
    // complete pass while collecting nothing, which is the worst shape here:
    // a silent miss reads exactly like "there was no credential."
    const c = createConnector({
      name: "callable-param",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.any() as never,
          classify: { kind: "read" },
          handler: async (p: { token: { value: string } }) => {
            throw new Error(`upstream rejected ${p.token.value}`);
          },
        },
      },
    });
    const env = await c.fetch("go", {
      token: Object.assign(() => {}, { value: "hunter2" }),
    } as never);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
    }
  });

  it("a revoked proxy in params is an incomplete walk, not a rejection", async () => {
    // Codex P2. `Array.isArray` is not a safe predicate on an arbitrary caller
    // value: on a revoked proxy it throws, and it sat OUTSIDE the `try` the
    // rest of that branch is wrapped in, so the throw escaped the walk and
    // turned `fetch()` into a rejection instead of an error envelope.
    const { proxy, revoke } = Proxy.revocable([] as unknown[], {});
    revoke();
    const c = createConnector({
      name: "revoked-proxy",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.any() as never,
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });
    // The contract is an envelope, never a thrown error. The walk fails closed
    // on the value it cannot inspect, which costs the candidate set — but the
    // handler never touches the proxy, so the call still completes.
    await expect(
      c.fetch("go", { creds: proxy } as never),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("a candidate survives normalization AND serialization together", async () => {
    // Codex P1. `addCandidate` adds four spellings of every value — raw,
    // trimmed, lowercased, uppercased — and serialized only the first two, so
    // the COMBINATION was open: a schema that lowercases `ABC"DEF` and a hook
    // that JSON-stringifies the result emits `abc\"def`, matching neither the
    // lowercased raw candidate nor the serialized original. Cross-product
    // rather than the reported example, because the gap was a missing pair and
    // one example cannot show which pairs are covered.
    const raw = 'ABC"DEF';
    const transforms: Array<[string, (v: string) => string]> = [
      ["identity", (v) => v],
      ["lowercase", (v) => v.toLowerCase()],
      ["uppercase", (v) => v.toUpperCase()],
    ];
    const renders: Array<[string, (v: string) => string]> = [
      ["raw", (v) => `rejected ${v}`],
      ["JSON", (v) => `payload ${JSON.stringify({ error: v })}`],
      ["repr", (v) => `repr {'e': '${v.replace(/'/g, "\\'")}'}`],
    ];
    for (const [tName, transform] of transforms) {
      for (const [rName, render] of renders) {
        const label = `${tName}/${rName}`;
        // Through the classify hook, which redacts from the PRE-caller
        // snapshot — a different candidate set from the handler path.
        const c = createConnector({
          name: `norm-${tName}-${rName}`,
          credentials: async () => ({ region: "us-east-1" }),
          sdk: async () => ({}),
          actions: {
            go: {
              params: z.object({
                password: z.string().transform(transform),
              }) as never,
              classify: ((p: { password: string }) => {
                throw new Error(render(p.password));
              }) as never,
            },
          },
        });
        const env = await c.fetch("go", { password: raw });
        expect(env.status).toBe("error");
        if (env.status === "error") {
          expect(env.message.toUpperCase(), label).not.toContain("ABC");
          expect(env.message.toUpperCase(), label).not.toContain("DEF");
        }
      }
    }
  });

  it("a SCALAR credentials param keeps its path in the diagnostic", async () => {
    // Codex P2. `isCredentialContainerPath` alone marked a scalar sensitive,
    // so `{credentials: "./creds.json"}` with a handler reporting `cannot open
    // ./creds.json` lost the filename — while scrubSecrets deliberately keeps
    // it, because `credentials` pointing at a file is a path and not a secret.
    // The two sides now ask the same question of the value.
    const c = createConnector({
      name: "creds-scalar",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({ credentials: z.string() }),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("cannot open ./creds.json");
          },
        },
      },
    });
    const env = await c.fetch("go", { credentials: "./creds.json" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("./creds.json");
    }
    // A credentials CONTAINER is still collected — the half that is a secret.
    const c2 = createConnector({
      name: "creds-container",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({ credentials: z.any() }) as never,
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env2 = await c2.fetch("go", { credentials: { pat: "hunter2" } });
    expect(env2.status).toBe("error");
    if (env2.status === "error") {
      expect(env2.message).not.toContain("hunter2");
    }
  });

  it("a plural service-prefixed credential CONTAINER is a redaction candidate", async () => {
    // Codex P1. `github_tokens` is the residue SENSITIVE_PATH_COMPOUND_RE
    // documents: the singular compound matches, the plural does not, so the
    // candidate set was empty and a handler echoing the token put it bare on
    // stdout. The name alone cannot decide it — `max_tokens` is the same shape
    // — so the collector pairs the name with the value, and a bundle is a
    // container while a count is a scalar.
    for (const key of [
      "github_tokens",
      "githubTokens",
      "db_passwords",
      "userApiKeys",
    ]) {
      for (const value of [["hunter2"], { primary: "hunter2" }]) {
        const c = createConnector({
          name: `plural-${key}`,
          credentials: async () => ({ region: "us-east-1" }),
          sdk: async () => ({}),
          actions: {
            go: {
              params: z.object({ [key]: z.any() }) as never,
              classify: { kind: "read" },
              handler: async () => {
                throw new Error("upstream rejected hunter2");
              },
            },
          },
        });
        const env = await c.fetch("go", { [key]: value });
        expect(env.status).toBe("error");
        if (env.status === "error") {
          expect(env.message, `${key} = ${JSON.stringify(value)}`).not.toContain(
            "hunter2",
          );
        }
      }
    }
  });

  it("a plural COUNT param keeps its diagnostic, number or string", async () => {
    // The counterpart, and the whole reason the plural rule is value-aware
    // rather than a wider regex. These are the commonest benign parameters in
    // an LLM toolkit — `src/toolkit/usage/` is built on them — and widening
    // SENSITIVE_PATH_COMPOUND_RE with `s?` redacts every one of them. A count
    // is a scalar in both spellings callers actually send.
    for (const key of [
      "max_tokens",
      "maxTokens",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
    ]) {
      for (const value of [4096, "4096"]) {
        const c = createConnector({
          name: `count-${key}-${typeof value}`,
          credentials: async () => ({ region: "us-east-1" }),
          sdk: async () => ({}),
          actions: {
            go: {
              params: z.object({ [key]: z.any() }) as never,
              classify: { kind: "read" },
              handler: async () => {
                throw new Error("upstream said limit-exceeded-4096");
              },
            },
          },
        });
        const env = await c.fetch("go", { [key]: value });
        expect(env.status).toBe("error");
        if (env.status === "error") {
          expect(env.message, `${key} = ${JSON.stringify(value)}`).toContain(
            "limit-exceeded-4096",
          );
        }
      }
    }
  });

  it("a benign count param keeps its diagnostic", async () => {
    // The counterpart of the rule above: widening the field-name vocabulary
    // must not start blanking ordinary messages.
    const c = createConnector({
      name: "count-param",
      credentials: async () => ({ region: "us-east-1" }),
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({ max_tokens: z.string() }),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream said limit-exceeded-42");
          },
        },
      },
    });
    const env = await c.fetch("go", { max_tokens: "42" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("limit-exceeded-42");
    }
  });

  it("a symbol-keyed credential is still a redaction candidate", async () => {
    // Third key-kind in this walk. `Object.keys` missed non-enumerable, then
    // `getOwnPropertyNames` missed symbols. `Reflect.ownKeys` is the
    // language's own definition of "own property", so there is no fourth.
    const SYM = Symbol("shared-token");
    const creds: Record<string | symbol, unknown> = {
      region: "us-east-1",
      [SYM]: "SYMBOL-SECRET-99",
    };
    const c = createConnector({
      name: "symbol-test",
      credentials: async () => creds as never,
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected SYMBOL-SECRET-99");
          },
        },
      },
    });
    const env = await c.fetch("go", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("SYMBOL-SECRET-99");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("an SDK-only secret leaks by default, and the diagnostic is why", async () => {
    // The default is deliberate, so it is pinned. `credentials()` fulfils and
    // `sdk()` rejects: nothing the redactor can see matches, so the message
    // goes through. Failing this path closed unconditionally would blank the
    // first-run onboarding message of all seven shipped connectors, whose
    // "credentials are missing" surfaces on exactly this path and names an
    // environment variable rather than a secret.
    const c = createConnector({
      name: "sdk-default",
      credentials: async () => ({}) as never,
      sdk: async () => {
        throw new Error("set GITHUB_TOKEN to continue");
      },
      actions: {
        go: { params: z.object({}), classify: { kind: "read" }, handler: async () => ({}) },
      },
    });
    const env = await c.fetch("go", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toContain("GITHUB_TOKEN");
    }
  });

  it("sdkReadsOwnCredentials fails an SDK rejection closed", async () => {
    // The opt-in for a connector whose `sdk()` holds secrets `credentials()`
    // never returns. The contract cannot detect that — `sdk()` is an opaque
    // thunk — so the connector declares it and the message is redacted
    // wholesale instead of matched against a set that cannot contain it.
    const c = createConnector({
      name: "sdk-owns-creds",
      sdkReadsOwnCredentials: true,
      credentials: async () => ({}) as never,
      sdk: async () => {
        throw new Error("vault rejected SDKONLY-SECRET-13");
      },
      actions: {
        go: { params: z.object({}), classify: { kind: "read" }, handler: async () => ({}) },
      },
    });
    const env = await c.fetch("go", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("SDKONLY-SECRET-13");
    }
  });

  it("a symbol-keyed PARAM is a redaction candidate", async () => {
    // The credential case above walks the credential object; params go
    // through the PATH-SCOPED walker, which asks the sensitive-path
    // vocabulary about each segment. `String(sym)` renders `Symbol("token")`
    // as `Symbol(token)`, which no predicate recognises — so making symbols
    // visible to the walk left their values outside the candidate set.
    // The description is the name the author actually chose.
    const SYM = Symbol("token");
    const params: Record<string | symbol, unknown> = { region: "us-east-1" };
    params[SYM] = "SYM-PARAM-SECRET-31";
    const c = createConnector({
      name: "symbol-param-test",
      credentials: async () => ({}) as never,
      sdk: async () => ({}),
      actions: {
        go: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async (p: Record<string | symbol, unknown>) => {
            throw new Error(`rejected ${String(p[SYM])}`);
          },
        },
      },
    });
    const env = await c.fetch("go", params as never);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("SYM-PARAM-SECRET-31");
      expect(env.message).toContain("[REDACTED]");
    }
  });

  it("a BARE token in the action slot is redacted too", async () => {
    // `scrubSecrets` matches shapes, so it caught `api_key=…` and returned
    // the likelier `--action "$GITHUB_TOKEN"` untouched. An invalid action is
    // never diagnostic — it is by definition not one of ours, and the message
    // already lists the ones that are — so the value goes whole rather than
    // through a matcher that cannot see it.
    const c = makeAws();
    const env = await c.fetch("ghp_live_DEADBEEF", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(JSON.stringify(env)).not.toContain("ghp_live_DEADBEEF");
      expect(env.action).toBe("[REDACTED]");
      // The actionable half survives.
      expect(env.message).toContain("list_functions");
    }
  });

  it("a registered action reaches the envelope unchanged", async () => {
    // The guard above returns before every later envelope, so `action` is a
    // declared identifier past that point and must not be mangled.
    const c = makeAws();
    const env = await c.fetch("list_functions", {});
    expect(env.action).toBe("list_functions");
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

  it("returns an envelope when a parameter accessor throws", async () => {
    // Reading a property can run caller code. The schema had already produced
    // an ordinary validation failure; the exception from collecting redaction
    // candidates then escaped in place of the envelope `fetch()` promises —
    // the redaction machinery breaking the contract it exists to protect.
    // An incomplete walk fails closed, which is what the caller already does.
    const boom = {};
    Object.defineProperty(boom, "trap", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    const c = createConnector<{}>({
      name: "throwing-getter-test",
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
    for (const params of [boom, { a: { b: boom } }, [1, boom]]) {
      const env = await c.fetch("login", params);
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.error_code).toBe("VALIDATION_ERROR");
        // Failed closed: candidates are unknown, so the message is dropped.
        expect(env.message).not.toContain("hunter2");
      }
    }
  });

  it("redacts a credential a handler echoes as prose", async () => {
    // `scrubSecrets` recognises SHAPES — `key=value`, Authorization, a URL
    // with userinfo. A handler that interpolates a credential into a sentence
    // presents none of them, so the token reached the stdout envelope and the
    // hardship recorder intact. The validation path has always redacted
    // against the input; the runtime path had no equivalent.
    const c = createConnector<{}>({
      name: "prose-echo-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({
            token: z.string(),
            table: z.string(),
            nested: z.object({ api_key: z.string() }).optional(),
          }),
          classify: { kind: "read" },
          handler: async (p: { token: string; table: string; nested?: { api_key: string } }) => {
            throw new Error(
              `upstream rejected ${p.token} for ${p.table}` +
                (p.nested !== undefined ? ` and ${p.nested.api_key}` : ""),
            );
          },
        },
      },
    });

    const env = await c.fetch("login", {
      token: "hunter2",
      table: "users",
      nested: { api_key: "sk-live-abc" },
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).not.toContain("sk-live-abc");
      // The benign parameter is the point of the path scoping: an error that
      // cannot name the table it failed on has stopped being an error report.
      expect(env.message).toContain("users");
      expect(env.message).toContain("upstream rejected");
    }
  });

  it("redacts a credential a mapError override echoes as prose", async () => {
    // A connector's custom mapper commonly interpolates the raw driver error,
    // and the override runs on the same path.
    const c = createConnector<{}>({
      name: "prose-echo-maperror",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ password: z.string() }),
          classify: { kind: "read" },
          handler: async (p: { password: string }) => {
            throw new Error(`denied ${p.password}`);
          },
        },
      },
      mapError: (err: unknown) => ({
        error_code: "AUTH_ERROR" as const,
        message: `mapped: ${err instanceof Error ? err.message : String(err)}`,
      }),
    });
    const env = await c.fetch("login", { password: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("mapped:");
    }
  });

  it("fails closed when the sensitive-value walk cannot finish", async () => {
    // A partial set may be missing the very value the message echoes, so
    // redacting against it would report success while leaking — the same rule
    // the validation path follows.
    const boom = {};
    Object.defineProperty(boom, "trap", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    const c = createConnector<{}>({
      name: "prose-echo-failclosed",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { token: "hunter2", boom });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
    }
  });

  it("redacts a credential whose sensitive path a transform renamed away", async () => {
    // Regression (Codex P1). Sensitivity lives in the PATH, and a transform is
    // precisely the operation that discards paths: `{password}` rewritten to
    // `{value}` leaves the validated object with no sensitively-named field,
    // so a handler throwing `rejected hunter2` collected no candidate at all
    // and the credential reached the envelope. Both representations are now
    // collected — the raw one still carries the field name.
    const c = createConnector<{}>({
      name: "transform-rename",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z
            .object({ password: z.string() })
            .transform((v) => ({ value: v.password })),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { password: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("redacts a transform-renamed credential a hook echoes as prose", async () => {
    // The two hook catch sites take the same rawParams argument. Fixing the
    // handler path and not its siblings is how the previous gap on these two
    // survived a round.
    for (const which of ["classify", "extendDecision"] as const) {
      const c = createConnector<{}>({
        name: `transform-rename-${which}`,
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z
              .object({ password: z.string() })
              .transform((v) => ({ value: v.password })),
            classify:
              which === "classify"
                ? () => {
                    throw new Error("rejected hunter2");
                  }
                : { kind: "read" as const },
            ...(which === "extendDecision" ? {} : {}),
            handler: async () => ({}),
          },
        },
        ...(which === "extendDecision"
          ? {
              extendDecision: (): never => {
                throw new Error("rejected hunter2");
              },
            }
          : {}),
      } as never);
      const env = await c.fetch("login", { password: "hunter2" });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message, `leaked via ${which}`).not.toContain("hunter2");
      }
    }
  });

  it("fails closed when the credentials loader itself rejects", async () => {
    // Regression (Codex P1) against the `loadedCreds` capture added earlier in
    // this run. If `credentials()` rejects, there is by definition nothing to
    // collect — and its message is the one most likely to name what it had
    // just read. Redacting against an empty candidate set reports success
    // while leaking, so the message is dropped whole.
    const c = createConnector<{}>({
      name: "creds-reject",
      credentials: async () => {
        throw new Error("vault rejected hunter2");
      },
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", {});
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).toBe("[REDACTED]");
  });

  it("fails closed when the SDK fails before credentials resolve", async () => {
    // Regression (Codex P1) against the `loadedCreds` capture from earlier in
    // this run. An SDK failure can win the race against a slow credential
    // loader: `loadedCreds` is undefined while the loader is still on its way
    // to returning the very value the SDK error names, and `credsUnavailable`
    // is false because nothing rejected. Redacting against an empty set there
    // reports success while leaking.
    //
    // Unresolved and rejected differ only in timing, and neither is
    // distinguishable at the point the message is redacted, so both fail
    // closed. The loader here resolves AFTER the failure, which is what makes
    // this different from the sibling test above.
    const c = createConnector<{}>({
      name: "creds-slow",
      credentials: () =>
        new Promise((resolve) => setTimeout(() => resolve({ token: "hunter2" }), 50)),
      sdk: async () => {
        throw new Error("upstream rejected hunter2");
      },
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", {});
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("does not wait for a hung loader after its sibling fails", async () => {
    // Regression (Codex P2) against the same change. `allSettled` waits for
    // EVERY sibling, so a fast configuration failure paired with a loader that
    // never settles turned a reportable setup error into a request that never
    // resolved. `Promise.all` rejects on the first failure instead.
    const c = createConnector<{}>({
      name: "hung-sibling",
      credentials: () => new Promise<never>(() => undefined),
      sdk: async () => {
        throw new Error("bad configuration");
      },
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await Promise.race([
      c.fetch("login", {}),
      new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT"), 3000)),
    ]);
    expect(env, "fetch() never reached the error branch").not.toBe("TIMED_OUT");
    expect((env as { status: string }).status).toBe("error");
  }, 10_000);

  it("fails closed on a class instance under a sensitive path", async () => {
    // Regression (Codex P1). `Object.prototype.toString.call(new Foo())` is
    // `[object Object]`, so the tag test written to exclude class instances
    // did not exclude them — verified, not assumed. A credential in a private
    // field behind a prototype getter enumerates to nothing and reported a
    // COMPLETE walk, which is the exact fail-open the check exists to stop.
    class Holder {
      readonly #secret: string;
      constructor(secret: string) {
        this.#secret = secret;
      }
      get value(): string {
        return this.#secret;
      }
    }
    const c = createConnector<{}>({
      name: "class-instance",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { token: new Holder("hunter2") });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("fails closed on an accessor at an array index", async () => {
    // Regression (Codex P2). Both walkers read `cur[i]` directly, so the
    // accessor rule the object branch enforces was only half present — an
    // indexed read runs caller code exactly as a property read does. Codex
    // named this in the original accessor thread and I fixed only the object
    // branch, which is what made it the next round's finding.
    //
    // The getter counts its own invocations, so this asserts the walk never
    // ran it rather than only that nothing leaked.
    let reads = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return "hunter2";
      },
    });
    Object.defineProperty(arr, "length", { value: 1, writable: true });
    const c = createConnector<{}>({
      name: "array-accessor",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { token: arr });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
    expect(reads, "the walk executed an indexed accessor").toBe(0);
  });

  it("collects a credential held as an array's non-index own property", async () => {
    // Regression (Codex P1). An array is an ordinary object underneath, and
    // the array branch iterated `0..length-1` and then reported a COMPLETE
    // walk. `Object.assign([], { token: "hunter2" })` passes an identity
    // schema on a programmatic `fetch()`, reaches the handler as
    // `params.token`, and contributed no candidate — so a handler echoing it
    // in prose had nothing to match, exactly as the non-enumerable and
    // symbol-key rounds did for objects.
    const arr = Object.assign([1, 2], { token: "hunter2" });
    const c = createConnector<{}>({
      name: "array-own-prop",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", arr);
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("fails closed on an accessor at an array's non-index own property", async () => {
    // The policy copied from `enumerableDataEntries`: never run caller code
    // to collect a candidate. Same rule the indexed-accessor case above
    // enforces, on the key class this walk newly visits.
    let reads = 0;
    const arr: unknown[] = [1];
    Object.defineProperty(arr, "token", {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return "hunter2";
      },
    });
    const c = createConnector<{}>({
      name: "array-own-accessor",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { creds: arr });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
    expect(reads, "the walk executed an own-property accessor").toBe(0);
  });

  it("collects an array own property in the all-input collector too", async () => {
    // Codex P1, the round after the array fix: `collectInputStrings` is the
    // SECOND walker with this branch, and fixing only the sensitive-path
    // walker left this one reporting a complete pass. A custom identity or
    // refinement schema echoing the value then reached `defaultErrorMap` with
    // no candidate for it.
    const arr = Object.assign([1], { extra: "hunter2" });
    const c = createConnector<{}>({
      name: "array-collector",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any().refine(() => false, { message: "rejected hunter2" }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", arr);
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("visits a property past the array-index ceiling", async () => {
    // Codex P2, same round. A JavaScript array index stops at `2**32 - 2`, so
    // `arr["4294967295"]` leaves `length` at 0 — the index loop visits
    // nothing — and classifying it as an index excluded it from the
    // own-property pass as well, so it was never visited at all.
    const arr: unknown[] = [];
    (arr as unknown as Record<string, unknown>)["4294967295"] = "hunter2";
    const c = createConnector<{}>({
      name: "array-index-ceiling",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { tokens: arr });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("snapshots inputs before safeParse, which runs caller code", async () => {
    // Codex P1. The snapshot was taken before `spec.handler`, which is one
    // call too late: `superRefine` runs inside `safeParse` and can read
    // `p.token`, delete it, and put the bare value in its own issue message.
    // `defaultErrorMap` then walked a `params` the value was no longer in,
    // and prose carries no shape for `scrubSecrets`.
    const c = createConnector<{}>({
      name: "refine-mutates",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any().superRefine((p: Record<string, string>, ctx) => {
            const t = p["token"];
            delete p["token"];
            ctx.addIssue({ code: "custom", message: `rejected ${t}` });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { token: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("snapshots inputs before the classify and extendDecision hooks", async () => {
    // Codex P1, the sibling ordering. Both hooks receive an object reachable
    // from `params` — an identity schema hands back the caller's own object —
    // so either can delete the key before throwing with the value in prose.
    const mk = (which: "classify" | "extend") =>
      createConnector<{}>({
        name: `hook-mutates-${which}`,
        credentials: async () => ({}),
        sdk: async () => ({}),
        ...(which === "classify"
          ? {
              classify: async (_a: string, v: unknown) => {
                const p = v as Record<string, string>;
                const t = p["token"];
                delete p["token"];
                throw new Error(`rejected ${t}`);
              },
            }
          : {
              extendDecision: (_d: unknown, ctx: { params: unknown }) => {
                const p = ctx.params as Record<string, string>;
                const t = p["token"];
                delete p["token"];
                throw new Error(`rejected ${t}`);
              },
            }),
        actions: {
          login: {
            params: z.any(),
            classify: { kind: "read" },
            handler: async () => ({}),
          },
        },
      } as never);
    for (const which of ["classify", "extend"] as const) {
      const env = await mk(which).fetch("login", { token: "hunter2" });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message, `${which} hook leaked`).not.toContain("hunter2");
      }
    }
  });

  it("fails closed on an array whose prototype cannot be vouched for", async () => {
    // Codex P1. `Array.isArray` tests the exotic object, not the prototype,
    // so a subclass reaches the array branch. A prototype can define
    // `token`, which `Reflect.ownKeys` does not report, so the walk would
    // claim a complete pass over a value the handler reads as `params.token`.
    class Tokens extends Array {}
    Object.defineProperty(Tokens.prototype, "token", {
      value: "hunter2",
      enumerable: true,
    });
    const arr = new Tokens();
    arr.push(1);
    const c = createConnector<{}>({
      name: "array-proto",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { creds: arr });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("redacts a credential the SDK loader echoes when it rejects", async () => {
    // Regression (Codex P1). `Promise.all` left the destructuring unassigned
    // when `sdk()` rejected, so `credentials` reached the redactor as
    // `undefined` and the walk had no candidate — while setup prose carries no
    // `key = value` shape for the pattern scrub to find either. The
    // credentials that DID resolve are the ones most likely to be named in a
    // setup failure, so they are kept via `allSettled`.
    const c = createConnector<{}>({
      name: "sdk-reject-creds",
      credentials: async () => ({ token: "hunter2" }),
      sdk: async () => {
        throw new Error("upstream rejected hunter2");
      },
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", {});
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("redacts a credential a refinement puts in the issue PATH", async () => {
    // Regression (Codex P1). Only `i.message` went through the input-aware
    // redactor; the path was emitted verbatim, so a refinement using the
    // rejected value as its path rendered `hunter2: invalid`.
    const c = createConnector<{}>({
      name: "issue-path-echo",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ password: z.string() }).superRefine((v, ctx) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [v.password],
              message: "invalid",
            });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { password: "hunter2" });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("keeps an ordinary field name in the issue path", async () => {
    // The other half: redacting the path must not blank ordinary field names,
    // which are the reason the path is kept when a message is dropped.
    const c = createConnector<{}>({
      name: "issue-path-plain",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ region: z.string() }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const env = await c.fetch("login", { region: 42 });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).toContain("region");
  });

  it("fails closed on a throwing Symbol.toStringTag", async () => {
    // Regression (Codex P2) against the plain-object check added for the
    // container hole: `Object.prototype.toString` reads a caller-defined
    // `Symbol.toStringTag`, which can be a getter and can throw. The guard
    // written to stop caller code escaping was itself an uncaught call to it.
    const trap = {};
    Object.defineProperty(trap, Symbol.toStringTag, {
      get() {
        throw new Error("tag exploded");
      },
    });
    const c = createConnector<{}>({
      name: "tostringtag-trap",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { token: "hunter2", trap });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
  });

  it("applies the node budget before materializing descriptors", async () => {
    // Regression (Codex P2). `getOwnPropertyDescriptors` builds one descriptor
    // object per property, so a very wide object bought the work and the
    // memory for all of them before `MAX_INPUT_NODES` was consulted.
    //
    // Asserted by COUNTING the call, not by timing it and not by the envelope.
    // The envelope cannot distinguish: an over-wide object trips the node
    // bound during the entry loop either way, so an output assertion passes
    // with the fix reverted — it proves nothing. A timing assertion would be a
    // CI-speed test. The observable property is that descriptors are never
    // materialized for an object past the remaining budget.
    const wide = Object.fromEntries(
      Array.from({ length: 60_000 }, (_, i) => [`k${i}`, `v${i}`]),
    );
    const real = Object.getOwnPropertyDescriptors;
    let descriptorCalls = 0;
    Object.defineProperty(Object, "getOwnPropertyDescriptors", {
      configurable: true,
      writable: true,
      value: (o: object) => {
        if (o === wide) descriptorCalls++;
        return real(o);
      },
    });
    try {
      const c = createConnector<{}>({
        name: "wide-budget",
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.any(),
            classify: { kind: "read" },
            handler: async () => {
              throw new Error("upstream rejected hunter2");
            },
          },
        },
      });
      const env = await c.fetch("login", { token: { wide, secret: "hunter2" } });
      expect(env.status).toBe("error");
      if (env.status === "error") expect(env.message).toBe("[REDACTED]");
      expect(
        descriptorCalls,
        "materialized descriptors for an over-budget object",
      ).toBe(0);
    } finally {
      Object.defineProperty(Object, "getOwnPropertyDescriptors", {
        configurable: true,
        writable: true,
        value: real,
      });
    }
  });

  it("redacts every occurrence of a punctuation-only credential", async () => {
    // Regression (Codex P2). The left boundary was a CONSUMING group, so one
    // match ate the character the next match needed to start from and
    // consecutive occurrences were half-redacted: `.` turned `rejected ..`
    // into `rejected [REDACTED].` and `--` turned `----` into `[REDACTED]--`,
    // leaving a complete credential in the envelope. Only punctuation values
    // reach this — an alphanumeric one cannot neighbour itself and still be a
    // whole token — which is why the earlier boundary tests never caught it.
    for (const [secret, echoed] of [
      [".", "rejected .."],
      ["--", "----"],
      ["-", "- -"],
    ]) {
      const c = createConnector<{}>({
        name: `punct-${Math.random()}`,
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.any(),
            classify: { kind: "read" },
            handler: async () => {
              throw new Error(echoed);
            },
          },
        },
      });
      const env = await c.fetch("login", { token: secret });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message, `left ${secret} standing`).not.toMatch(
          new RegExp(`(?<![A-Za-z0-9_])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`),
        );
      }
    }
  });

  it("still refuses a short value that is not a whole token", async () => {
    // The other half: making the boundary non-consuming must not turn the
    // whole-token rule into a substring rule. A `.` inside `3.14` is not the
    // credential, and redacting it would destroy an ordinary diagnostic.
    const c = createConnector<{}>({
      name: "punct-not-token",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream returned 3.14 for rate");
          },
        },
      },
    });
    const env = await c.fetch("login", { token: "." });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).toContain("3.14");
  });

  it("bounds redaction by characters scanned, not comparison count", async () => {
    // Regression (Codex P2). Each comparison is a pass over the WHOLE message,
    // so a count-only ceiling bounded how many passes happened and not how
    // much was read. Measured on the pre-fix code: 2000 candidates against a
    // 2 MB message cost 95ms on the `includes` branch and 2187ms on the
    // short-value regex branch — at 1% of the permitted 200,000 comparisons.
    //
    // Asserted on the OUTPUT, not on elapsed time: the budget must fail closed
    // and return `[REDACTED]`. A timing assertion here would be a CI-speed
    // test, and this file already carries one ratio test that is delicate
    // enough under load.
    const big = "x".repeat(4_000_000);
    const c = createConnector<{}>({
      name: "redaction-charge",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error(big);
          },
        },
      },
    });
    const token = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, `secret-value-${i}`]),
    );
    const env = await c.fetch("login", { token });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).toBe("[REDACTED]");
  });

  it("still redacts normally at a realistic message and candidate size", async () => {
    // The over-redaction guard, and it has to be SIZED to be one: a budget
    // that replaced every diagnostic with `[REDACTED]` would still pass a leak
    // test, so this pins a case a mis-scaled charge would break. 100 KB and
    // 100 candidates costs 100 units each = 10,000 of the permitted 200,000 at
    // the 1 KB unit, and 10,000,000 if the unit were characters. A first
    // version of this test used a 50-character message and one candidate,
    // which both scalings pass — it proved nothing.
    const filler = "upstream rejected the request. ".repeat(3300); // ~100 KB
    const c = createConnector<{}>({
      name: "redaction-charge-realistic",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error(`${filler} value hunter2 was refused`);
          },
        },
      },
    });
    const token = Object.fromEntries([
      ...Array.from({ length: 99 }, (_, i) => [`k${i}`, `unused-value-${i}`]),
      ["secret", "hunter2"],
    ]);
    const env = await c.fetch("login", { token });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message, "budget over-redacted an ordinary error").toContain(
        "upstream rejected the request",
      );
    }
  });

  it("fails closed on a container the walk cannot enumerate", async () => {
    // Regression (Codex P1). `Object.entries`/`Object.values` return `[]` for
    // a Map or a Set, so the walk reported a COMPLETE traversal with no
    // candidates — a silent empty result from the function whose whole job is
    // to decide what to redact, and the caller's fail-closed path never fired.
    // The contrast is the proof: same sensitive path, three container types.
    const build = (token: unknown): Promise<unknown> => {
      const c = createConnector<{}>({
        name: `container-${Math.random()}`,
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.any(),
            classify: { kind: "read" },
            handler: async () => {
              throw new Error("upstream rejected hunter2");
            },
          },
        },
      });
      return c.fetch("login", { token });
    };
    for (const token of [
      { k: "hunter2" },
      new Map([["k", "hunter2"]]),
      new Set(["hunter2"]),
    ]) {
      const env = (await build(token)) as { status: string; message?: string };
      expect(env.status).toBe("error");
      expect(env.message ?? "").not.toContain("hunter2");
    }
  });

  it("fails closed on an accessor rather than reading it", async () => {
    // Regression (Codex P2). An earlier round caught a getter that THREW; the
    // catch does nothing for one that returns quietly, which runs caller code
    // on the validation-error path, nor for one that BLOCKS — and a getter
    // that never returns means fetch() never resolves at all, which is worse
    // than the exception because there is no error to report. Descriptors are
    // inspected instead of values.
    //
    // This getter counts its own invocations, so the assertion is that the
    // walk never ran it, not merely that nothing leaked.
    let reads = 0;
    const lazy = {};
    Object.defineProperty(lazy, "computed", {
      enumerable: true,
      get() {
        reads++;
        return "hunter2";
      },
    });
    const c = createConnector<{}>({
      name: "accessor-failclosed",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2");
          },
        },
      },
    });
    const env = await c.fetch("login", { token: lazy });
    expect(env.status).toBe("error");
    if (env.status === "error") expect(env.message).not.toContain("hunter2");
    expect(reads, "the walk executed a getter").toBe(0);
  });

  it("redacts a credential a hook echoes as prose", async () => {
    // classify() and extendDecision() return their own CONFIG_ERROR envelopes
    // and never reach the handler error path, so the input-aware redaction
    // added for that path did not cover them. Both hooks, because fixing one
    // and not its sibling is how the previous gap survived a round.
    for (const which of ["classify", "extendDecision"] as const) {
      const spec: Record<string, unknown> = {
        params: z.object({ token: z.string() }),
        classify:
          which === "classify"
            ? () => {
                throw new Error("classification rejected hunter2");
              }
            : { kind: "read" as const },
        handler: async () => ({}),
      };
      const cfg: Record<string, unknown> = {
        name: `hook-echo-${which}`,
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: { login: spec },
      };
      if (which === "extendDecision") {
        cfg["extendDecision"] = (): never => {
          throw new Error("extension rejected hunter2");
        };
      }
      const env = await createConnector<{}>(cfg as never).fetch("login", { token: "hunter2" });
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.error_code).toBe("CONFIG_ERROR");
        expect(env.message, which).not.toContain("hunter2");
        expect(env.message, which).toContain("threw:");
      }
    }
  });

  it("redacts a credential that came from credentials(), not params", async () => {
    // A connector credential never appears in params, so a params-only
    // collector found no candidate for it. Credentials contribute EVERY
    // string: the object is secret by construction, and the field names a
    // provider picks need not be in any vocabulary.
    const c = createConnector<{ sessionId: string }>({
      name: "creds-echo-test",
      credentials: async () => ({ sessionId: "hunter2" }),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ q: z.string() }),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("upstream rejected hunter2 for query");
          },
        },
      },
    });
    const env = await c.fetch("login", { q: "x" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("upstream rejected");
    }
  });

  it("collects through a sensitive alias regardless of property order", async () => {
    // One object reachable by two paths made sensitivity depend on property
    // order: the LIFO walk reached it through `metadata` first, marked it seen
    // having collected nothing, and skipped the `token` alias entirely. Both
    // orders, because the bug is only visible in one of them.
    for (const params of [
      { metadata: { inner: "hunter2" }, token: { inner: "hunter2" } },
      { token: { inner: "hunter2" }, metadata: { inner: "hunter2" } },
    ]) {
      const shared = { inner: "hunter2" };
      const aliased =
        "metadata" in params && "token" in params
          ? Object.keys(params)[0] === "metadata"
            ? { metadata: shared, token: shared }
            : { token: shared, metadata: shared }
          : params;
      const c = createConnector<{}>({
        name: "alias-order-test",
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.any(),
            classify: { kind: "read" },
            handler: async () => {
              throw new Error("rejected hunter2");
            },
          },
        },
      });
      const env = await c.fetch("login", aliased);
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.message, JSON.stringify(Object.keys(aliased))).not.toContain("hunter2");
      }
    }
  });

  it("treats a credentials container as sensitive", async () => {
    // `pat` is in no vocabulary and never will be; `credentials` is the only
    // thing in `credentials.pat` that says what it holds. Kept separate from
    // `isSensitiveFieldPath` because that predicate also decides whether a
    // VALIDATION message is dropped whole, and folding this in degraded five
    // existing diagnostics from redacted-echo to dropped-message.
    const c = createConnector<{}>({
      name: "creds-container-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any(),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("rejected hunter2 for users");
          },
        },
      },
    });
    const env = await c.fetch("login", {
      credentials: { pat: "hunter2" },
      table: "users",
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      expect(env.message).toContain("users");
    }
  });

  it("recognizes a plural credential container", async () => {
    // The array walk states that entries of `tokens` inherit their container's
    // sensitivity; the path vocabulary only knew the singular, so the
    // invariant was false and a plural container contributed no candidate.
    const c = createConnector<{}>({
      name: "plural-container-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ tokens: z.array(z.string()), tables: z.array(z.string()) }),
          classify: { kind: "read" },
          handler: async (p: { tokens: string[]; tables: string[] }) => {
            throw new Error(`rejected ${p.tokens[0]} on ${p.tables[0]}`);
          },
        },
      },
    });
    const env = await c.fetch("login", { tokens: ["hunter2"], tables: ["users"] });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
      // Pluralising the PATH vocabulary must not pull benign containers in.
      expect(env.message).toContain("users");
    }
  });

  it("leaves a runtime message alone when no parameter is sensitive", async () => {
    // Nothing to match against means nothing to redact — the message must not
    // be blanked defensively, or every ordinary connection error loses its
    // diagnostic.
    const c = createConnector<{}>({
      name: "prose-echo-nonsensitive",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.object({ table: z.string() }),
          classify: { kind: "read" },
          handler: async (p: { table: string }) => {
            throw new Error(`ECONNREFUSED reading ${p.table}`);
          },
        },
      },
    });
    const env = await c.fetch("login", { table: "users" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).toBe("ECONNREFUSED reading users");
    }
  });

  it("returns an envelope when an array iterator throws", async () => {
    // Sibling of the accessor case above, and the same contract: the array
    // branch used `for…of`, which reads and calls `cur[Symbol.iterator]` —
    // caller code on an array subclass. Zod can reject the value without ever
    // iterating it, so the schema produced its validation failure and the
    // exception from collecting redaction candidates escaped instead of the
    // envelope. Walking by index reaches no iteration protocol.
    class Hostile extends Array {
      [Symbol.iterator](): never {
        throw new Error("iterator exploded");
      }
    }
    const hostile = Hostile.from([1, 2, 3]) as unknown[];
    const c = createConnector<{}>({
      name: "throwing-iterator-test",
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
    // Unlike the accessor case this does NOT have to fail closed: an indexed
    // walk reads elements 1, 2, 3 successfully, so the candidate set is
    // complete and correct. What is asserted is the contract that broke —
    // `fetch()` resolves to an envelope instead of rejecting.
    for (const params of [hostile, { a: hostile }, [1, hostile]]) {
      const env = await c.fetch("login", params);
      expect(env.status).toBe("error");
      if (env.status === "error") {
        expect(env.error_code).toBe("VALIDATION_ERROR");
      }
    }
    // And a credential inside a hostile array is still found and redacted.
    const withSecret = Hostile.from(["hunter2"]) as unknown[];
    const env = await c.fetch("login", withSecret);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
    }
  });

  it("still collects candidates from an ordinary array", async () => {
    // The index walk has to keep finding what the iterator walk found, or the
    // fix above trades an escape for a leak.
    const c = createConnector<{}>({
      name: "array-candidate-test",
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
    const env = await c.fetch("login", ["hunter2"]);
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.message).not.toContain("hunter2");
    }
  });

  it("holds the node bound while enqueuing, not only while popping", async () => {
    // The bound was checked on the way out, so a container pushed its whole
    // contents first: `new Array(100_000_000)` is cheap to construct and
    // reachable through a programmatic `fetch()`, and it grew the work stack
    // to 100M entries before the bound was consulted again. Time was never the
    // tell — 8M slots cost 68ms while taking 311MB — so this asserts the shape
    // of the cost, not a duration.
    const c = createConnector<{}>({
      name: "wide-array-test",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        login: {
          params: z.any().superRefine((_v, ctx) => {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rejected" });
          }),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const cost = async (n: number): Promise<number> => {
      const before = process.memoryUsage().heapUsed;
      const env = await c.fetch("login", new Array(n));
      expect(env.status).toBe("error");
      return process.memoryUsage().heapUsed - before;
    };
    await cost(1_000_000);
    const wide = await cost(100_000_000);
    // 100x the slots. Unbounded enqueue allocates one stack entry each, which
    // is hundreds of MB; a held bound stops at MAX_INPUT_NODES regardless.
    expect(wide).toBeLessThan(200_000_000);
  }, 120_000);

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
      // Best of three: the ratio is the assertion, so one descheduling spike
      // in either measurement moves it. Vitest runs files in parallel and this
      // flaked under full-suite load while passing in isolation. The minimum
      // measures the work rather than the scheduler, which is cheaper than
      // loosening the threshold — that would cost the test its teeth.
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        await c.fetch("login", { ids });
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      return best;
    };
    await time(1000); // warm up the JIT so the ratio measures the algorithm
    const small = await time(2000);
    const large = await time(8000);
    // 4x the input. Linear predicts ~4x, quadratic ~16x. A threshold of 8
    // separates them with room for noise; the pre-fix code measured ~13x.
    expect(large).toBeLessThan(Math.max(small, 0.5) * 8);
  }, 120_000);

  it("walks a deeply nested object in linear time", async () => {
    // Regression (Codex P2). The walker rebuilt the full dotted path at every
    // level and rescanned that growing string with two sensitivity regexes, so
    // depth cost O(depth^2) — measured, a 20,000-deep chain of ordinary
    // `metadata` keys took 8539ms of synchronous work on an error path, under
    // the `MAX_INPUT_NODES` ceiling the whole time. It is 13ms now.
    //
    // Ratios rather than absolute times, so this is not a CI-speed test, and
    // best-of-three because the ratio is the assertion and one descheduling
    // spike in either measurement moves it — the same shape as the wide
    // validation test above, for the same reason.
    const time = async (depth: number): Promise<number> => {
      let node: Record<string, unknown> = { leaf: "x" };
      for (let i = 0; i < depth; i++) node = { metadata: node };
      const c = createConnector<{}>({
        name: `deep-${depth}`,
        credentials: async () => ({}),
        sdk: async () => ({}),
        actions: {
          login: {
            params: z.any(),
            classify: { kind: "read" },
            handler: async () => {
              throw new Error("upstream rejected hunter2");
            },
          },
        },
      });
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        await c.fetch("login", { token: "hunter2", deep: node });
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      return best;
    };
    await time(2_000); // warm up the JIT so the ratio measures the algorithm
    const small = await time(5_000);
    const large = await time(20_000);
    // 4x the depth. Linear predicts ~4x, quadratic ~16x. A threshold of 8
    // separates them with room for noise; measured 3.3x after the fix.
    expect(large).toBeLessThan(Math.max(small, 0.5) * 8);
  }, 240_000);

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

  it("does not surface credentials through the policy-config load error", async () => {
    // `loadPolicyConfig` validation errors USED TO echo the offending value
    // (`validateRule` interpolated it via JSON.stringify) and `policyLoadError`
    // reaches the CONFIG_ERROR envelope that `main()` writes to stdout.
    //
    // The fix moved to the PRODUCER: the loader now reports `got: <type>`, so
    // there is no value in the message for `scrubSecrets` to find. That is
    // why this no longer asserts `[REDACTED]` — a shape-based scrub could
    // never have caught a bare token here anyway, which is what made the
    // consumer-side scrub the wrong layer. It stays in place as defence in
    // depth. See tests/toolkit/policy_config.test.ts for the producer side.
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
      expect(env.message).not.toContain("postgres://");
      // The actionable half survives: which field, and what was expected.
      expect(env.message).toContain("policy.read");
      expect(env.message).toContain("success, escalate, denied");
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

  it("a malformed --params never echoes the input, whatever its shape", async () => {
    // `JSON.parse` quotes the offending input verbatim, and `--params
    // "$GITHUB_TOKEN"` is an ordinary shell slip. This path runs before any
    // credentials load, so there is no candidate set to redact against and
    // `scrubSecrets` cannot see a bare token. Nothing derived from the input
    // is echoed — only DIGITS are copied out of the parser message, and a
    // position can never carry a secret.
    //
    // Three shapes, because the previous two rounds each fixed one input and
    // the next round arrived with a narrower one.
    const cases: Array<[string, string]> = [
      ["ghp_live_DEADBEEF", "ghp_live_DEADBEEF"],
      ['{"password":hunter2}', "hunter2"],
      ["mongodb://u:pw123@h", "pw123"],
    ];
    for (const [raw, secret] of cases) {
      const c = makeAws();
      const writes: string[] = [];
      const errs: string[] = [];
      const origWrite = process.stdout.write;
      const origErr = process.stderr.write;
      process.stdout.write = ((x: string | Uint8Array): boolean => {
        writes.push(typeof x === "string" ? x : x.toString());
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((x: string | Uint8Array): boolean => {
        errs.push(typeof x === "string" ? x : x.toString());
        return true;
      }) as typeof process.stderr.write;
      try {
        const code = await c.main(["--action", "list_functions", "--params", raw]);
        expect(code).toBe(2);
        const all = writes.join("") + errs.join("");
        expect(all, `leaked for input ${raw}`).not.toContain(secret);
        // The actionable half survives on both streams.
        expect(writes.join("")).toContain("must be valid JSON");
        expect(errs.join("")).toContain("must be valid JSON");
      } finally {
        process.stdout.write = origWrite;
        process.stderr.write = origErr;
      }
    }
  });

  it("malformed --params scrubs the action field on stdout", async () => {
    // `writeArgErrorEnvelope` runs BEFORE the `validActions` guard, so its
    // `action` is raw `--action` argv. This is the sibling of the
    // unknown-action leak: same field, different path, and fixing only one
    // leaves the other open.
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = ((x: string | Uint8Array): boolean => {
      writes.push(typeof x === "string" ? x : x.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main([
        "--action", "api_key=sk-live-CLITEST",
        "--params", "not json",
      ]);
      expect(code).toBe(2);
      const out = writes.join("");
      expect(out).not.toContain("sk-live-CLITEST");
      expect(JSON.parse(out.trim()).action).toBe("[REDACTED]");
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErr;
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
