# Action design

How to design the action surface of a new connector — what to expose, how to validate, and what classifications to assign.

## What an action is

An action is a named operation the connector exposes. From the user's perspective, it's `--action <name> --params '<json>'`. From the toolkit's perspective, it's an entry in the `actions` dictionary with four fields:

```ts
get_customer: {
  description: "Fetch a customer by ID",
  params: z.object({ id: z.string().min(1) }),
  classify: { kind: "read" },
  handler: async (p, ctx) => { /* ... */ },
}
```

## Naming conventions

- **Snake case**, lowercase: `get_customer`, `list_charges`, `query_database`.
- **Verb-first**: `get_*`, `list_*`, `search_*`, `query_*` for reads; `create_*`, `update_*`, `delete_*`, `post_*` for writes.
- **Don't pluralize**: `list_customers` (plural noun) is fine; `gets_customer` is not.

The naming itself is what the skill uses as a *signal* for default classification — anything starting with `create_`, `update_`, `delete_`, `post_`, `send_`, `revoke_` defaults to non-read.

## Param schemas with Zod

The params field is a Zod schema. The toolkit calls `params.parse(rawParams)` before your handler runs; failures become `VALIDATION_ERROR` envelopes automatically.

Common patterns:

```ts
// String IDs
const getCustomerParams = z.object({
  id: z.string().min(1, "id is required"),
});

// Optional with default
const listChargesParams = z.object({
  customer_id: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

// UUID validation
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/;
const getPageParams = z.object({
  page_id: z.string().regex(UUID_RE, "Invalid page_id — expected UUID format"),
});

// Enum
const searchParams = z.object({
  query: z.string().min(1),
  filter_type: z.enum(["page", "database"]).optional(),
});

// Free-form JSON
const queryParams = z.object({
  filter: z.record(z.unknown()).nullable().default(null),
});
```

`z.coerce.number()` is useful because CLI params come in as strings; it converts them to numbers without the user having to quote them differently.

## Classification

Every action carries a `classify: { kind: ... }`. The toolkit's policy gate uses this to decide whether to run the handler, ask for approval, escalate, or deny.

| `kind` | Examples | Default approval mode |
|---|---|---|
| `read` | `get_*`, `list_*`, `search_*`, `query_*` | `auto` (no prompt) |
| `write` | `create_*`, `update_*`, `post_*`, `send_*` | `confirm_once` (per session) |
| `delete` | `delete_*`, `remove_*`, `archive_*` | `confirm_each` (per call) |
| `admin` | role/permission changes, user provisioning | `grant_required` (out-of-band) |
| `privilege` | `grant_*`, `revoke_*` on access controls | `grant_required` |

The defaults are sensible but not hard rules; the user can override per action during interview.

## The handler signature

```ts
handler: async (params, ctx) => {
  // params is fully validated (Zod has run)
  // ctx has: sdk (your client), creds, name, action
  const result = await ctx.sdk.getCustomer(params.id);
  throwIfError(result);  // converts !ok results into a thrown ServiceError
  return {
    id: result.data.id,
    email: result.data.email,
    // shape what you return — this becomes envelope.data
  };
}
```

Don't return the raw API response — pick out the fields the user actually wants. The shape you return is the contract callers see.

If you throw, the toolkit catches and runs `mapError(err)` to translate. If `mapError` returns `undefined`, the toolkit falls back to `CONNECTION_ERROR` with the error message.

## Approval modes (when classification is non-read)

The toolkit reads the connector's policy config (`~/.connectors/<slug>/config.yaml` or `.connectors/<slug>/config.yaml` in cwd) and resolves an approval mode per action:

- `auto` — handler runs, no prompt.
- `confirm_once` — first call in a session prompts the user; subsequent calls auto-allow.
- `confirm_each` — every call prompts.
- `grant_required` — refuses to run unless the user has issued a `--grant` token via the toolkit's grant CLI.

When the user defines a write/delete action during interview, the skill asks which approval mode to default to. Most users want `confirm_once` for writes, `grant_required` for delete/admin/privilege.

**Write-action happy-path tests need a permissive config in scope.** The toolkit's default policy escalates writes when no operator config is present. So for a connector that exposes any non-`read` action, the unit tests that assert `success` for the write action must set up a temp `HOME`/`cwd` with a permissive `.{name}-agent/config.yaml` (e.g., `policy: { write: success }, approval_mode: auto`) in `beforeAll`, and tear it down in `afterAll`. Read-only happy-path tests don't need this — `read` defaults to `allow`. The skill's `tests/integration/framework.test.ts.tmpl` already does this pattern for the escalate test; mirror it for write-action happy paths.

## Non-HTTP shapes (CLI-wrap, RPC, anything not REST/GraphQL)

The default `client.ts.tmpl` is HTTP-shaped: it bakes in `validateUrl`, `_throttle`, `_authHeaders`, `request<T>(method, relPath, ...)`, `Retry-After` parsing, and `fetchImpl` injection. For connectors that don't speak HTTP — e.g., wrapping a CLI binary via `child_process.execFile`, an RPC client, or anything else — write the client from scratch instead of trying to retrofit the HTTP frame. Preserve these load-bearing contracts so the rest of the toolkit fits:

- The same `Result<T>` discriminated union: `{ ok: true; data: T; status: number } | { ok: false; code: string; message: string; retriable: boolean; status?: number }`. Many tests + the `index.ts` handlers depend on this shape.
- An exported `load<Service>Credentials()` function (returns `{}` if the wrapped tool authenticates itself locally, or whatever object the client constructor expects).
- The matching `<Service>Error` bridge class in `error.ts`.
- The same `CODE_MAP` shape in `index.ts`.

For test-time injection, mirror the `fetchImpl` pattern with a shape-appropriate analog (e.g., `execFileImpl` for CLI wraps, `clientImpl` for RPC). Tests then stub the analog instead of `fetchImpl`. The `cli.test.ts` and `client_extras.test.ts` template helpers will need adapting — that's expected for non-HTTP shapes.

## What NOT to expose as actions

- **Internal pagination cursors** — handle pagination inside the handler; expose a single `list_*` action that does the full pass (capped at a reasonable max).
- **Auth flows** — credentials come from env/config; never let the user pass them as action params.
- **Raw HTTP plumbing** — if the user could call your underlying client directly, they'd just use `curl`. The connector's value is the *shaped, validated, gated* surface.
- **Secrets in responses** — the toolkit scrubs known secret patterns, but don't rely on it; redact in the handler.

## Examples from existing connectors

- `notion-agent-connector` — 7 actions: `search`, `get_page`, `get_database`, `query_database`, `list_attachments`, `get_attachment`, `get_comments`. All `read`.
- `github-agent-connector` — multiple read actions over Octokit. All `read`.
- `db-agent-connector` — single `query` action; classification is computed at runtime by parsing the SQL. (This is the one connector where the classification is dynamic.)
