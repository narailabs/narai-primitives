# Connector anatomy

The canonical shape of an action-dispatch connector built on `@narai/connector-toolkit@^3.x`. Read this when you need a fuller picture than what `SKILL.md` covers — typically when scaffolding something unusual or debugging why a generated file is shaped the way it is.

## The two surfaces

Every connector exposes two consumption modes from the same code:

- **CLI** — `npx <pkg> --action <name> --params '<json>'` emits a JSON envelope on stdout. Implemented by `connector.main(argv)` from the toolkit. Stdout is JSON-only; diagnostics go to stderr.
- **Library** — `import { fetch } from "@narai/<pkg>"; await fetch(action, params)` returns the same envelope as a JS object. Implemented by `connector.fetch(action, params)`.

Both are returned by a single `createConnector<TSdk>` call. You don't write the dispatch logic — the toolkit does.

## The factory call

```ts
return createConnector<MyClient>({
  name: "myservice",                     // connector slug; used for audit, hardship, policy
  version: "0.1.0",
  scope: (ctx) => ctx.sdk.workspaceId,   // optional: returns a tenant id; null = global tier
  credentials: async () => ({...}),       // resolved creds; passed to sdk if you call it manually
  sdk: async () => new MyClient({...}),   // build the client; called once per main()/fetch()
  actions: { /* action dictionary */ },
  mapError: (err) => {/* ... */},        // optional: translate exceptions to canonical envelopes
});
```

The toolkit owns:

- Argument parsing (`parseAgentArgs` strict whitelist)
- Zod validation of `params` per action
- Policy-gate evaluation (classification + approval mode + rules)
- Audit JSONL emission
- Hardship JSONL recording
- Envelope construction (success / denied / escalate / error)
- The `--curate` flag

You own:

- Action definitions (Zod schema + classification + handler)
- The HTTP/SDK client itself
- Error mapping from your client's internal codes to toolkit's canonical taxonomy

## The action dictionary

```ts
actions: {
  get_customer: {
    description: "Fetch a customer by ID",
    params: z.object({ id: z.string().min(1) }),
    classify: { kind: "read" },
    handler: async (p, ctx) => {
      const result = await ctx.sdk.getCustomer(p.id);
      throwIfError(result);
      return result.data;     // becomes envelope.data
    },
  },
  // ...
}
```

- `description` — surfaced by `--help` and the toolkit's introspection. Keep it tight.
- `params` — a Zod schema. The toolkit validates inputs before calling the handler; validation failures become a `VALIDATION_ERROR` envelope with no handler invocation.
- `classify` — `{ kind: "read" | "write" | "delete" | "admin" | "privilege" }`. Drives the policy gate and approval-mode resolution. Default to `read` unless the action genuinely mutates state.
- `handler` — receives validated params + a context with `sdk` (your client), `creds`, `name`, `action`. Whatever you return becomes the envelope's `data` field. If you throw, `mapError` decides how to translate.

## The Result-envelope client pattern

Inside `src/lib/<svc>_client.ts`, methods return a discriminated union rather than throwing:

```ts
export type ServiceResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; code: string; message: string; retriable: boolean; status?: number };
```

Why: it lets the client express *expected failures* (rate limit, auth error, network) declaratively, while the toolkit's handler-throws-an-Error contract takes over for the *unexpected* path. The bridge is `throwIfError(result)` in the handler:

```ts
function throwIfError<T>(r: ServiceResult<T>): asserts r is Extract<ServiceResult<T>, { ok: true }> {
  if (!r.ok) throw new ServiceError(r.code, r.message, r.retriable, r.status);
}
```

`ServiceError` carries the service-internal code; `mapError` translates it to a toolkit canonical code (`AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `VALIDATION_ERROR`, `CONFIG_ERROR`, `CONNECTION_ERROR`).

## Required client features

The frame in `client.ts.tmpl` covers all of these — don't reinvent:

- **Sliding-window rate limit** (per-minute) with a configurable cap.
- **Retry loop** (max 4 attempts) on retriable errors: 5xx, 429, network/timeout. Honors `Retry-After` header when present; falls back to exponential backoff (capped at 30s).
- **HTTP method allowlist**: only `GET`, `POST`, `PUT`, `PATCH`, `DELETE` reach the wire. The default template covers all five so you don't need to extend.
- **URL validation** via `validateUrl` from the toolkit (rejects non-http/https).
- **Dependency injection**: `fetchImpl` and `sleepImpl` are constructor options so tests can mock without touching the global fetch.
- **Configurable timeouts**: `connectTimeoutMs` (default 10s) + `readTimeoutMs` (default 30s); enforced by an `AbortController`.

## Error code taxonomy

| Toolkit code | When |
|---|---|
| `AUTH_ERROR` | 401, 403, missing/invalid credentials |
| `NOT_FOUND` | 404 |
| `RATE_LIMITED` | 429 |
| `TIMEOUT` | Request aborted on timer |
| `VALIDATION_ERROR` | 400, 422, Zod validation failure, invalid URL/method |
| `CONFIG_ERROR` | Credentials not configured, connector misconfigured |
| `CONNECTION_ERROR` | 5xx, network errors, anything else |

Map your service's internal codes (e.g., Stripe's `card_declined`) to these via `CODE_MAP`.

## What to read in the codebase for examples

- `/Users/narayan/src/connectors/notion-agent-connector/src/index.ts` — full factory call with 7 actions
- `/Users/narayan/src/connectors/notion-agent-connector/src/lib/notion_client.ts` — full Result-envelope client
- `/Users/narayan/src/connectors/connector-toolkit/src/index.ts` — toolkit's public API surface (the contract you're consuming)
