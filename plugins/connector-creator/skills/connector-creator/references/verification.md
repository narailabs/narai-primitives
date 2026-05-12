# Verification

Step-by-step smoke test for a freshly scaffolded connector. Run this before declaring the scaffold "done".

## Prerequisites

- The new connector lives at `<workspace>/<svc>-agent-connector/` (default: `/Users/narayan/src/connectors/<svc>-agent-connector/`).
- Node 20+ is available (`node --version`).
- The npm scope `@narai` is reachable (the connector depends on `@narai/connector-toolkit`, `@narai/credential-providers`, `@narai/connector-config`).

## Steps

### 1. Install dependencies

```bash
cd <new-connector-dir>
npm install
```

Expect: clean install, no warnings about missing peers (carets resolve).

If `npm install` fails on `@narai/*` packages, the user may not have access to the private npm scope. The skill should flag this.

### 2. Build

```bash
npm run build
```

Expect: `dist/` directory populated with compiled JS + `.d.ts`. No TS errors.

If errors mention "Cannot find module '@narai/connector-toolkit'", install failed silently — re-run step 1 with `--verbose`.

If errors mention strict TS settings (`exactOptionalPropertyTypes`, `noUnusedParameters`), the generated code has issues. Read the error, fix, re-run.

### 3. Typecheck

```bash
npm run typecheck
```

Expect: silent success.

This is mostly redundant with `build`, but it's faster (no emit) and catches anything `tsc` would warn about. Useful in CI.

### 4. Test

```bash
npm test
```

Expect: vitest reports all tests passing.

Common failures:
- **Mock fetch returns wrong shape**: the test's `jsonResponse({...})` body doesn't match what the client method expects. Check the action's response shape contract.
- **Rate limiter sleeps in test**: `sleepImpl` should be `async () => {}` (no-op) in tests.
- **Hardship logger writes to real `~/.claude/`**: integration tests should set `process.env.HOME` to a tmpdir; check `beforeEach`.

### 5. Smoke envelope

```bash
node dist/cli.js --action <first-action> --params '{}'
```

Expect: a JSON object on stdout. Without credentials configured, you'll see something like:

```json
{
  "status": "error",
  "action": "<first-action>",
  "error_code": "CONFIG_ERROR",
  "message": "<service> credentials not configured. Set <SVC>_TOKEN or register a credential provider via @narai/credential-providers.",
  "retriable": false
}
```

That's the **right** shape — the CLI plumbing works end-to-end. We're testing the envelope structure, not connectivity.

If the output is **not** valid JSON (e.g., a stack trace, "command not found", or shell noise), something is broken upstream. Common causes:

- `dist/cli.js` doesn't exist → step 2 (build) failed.
- The shebang `#!/usr/bin/env node` is missing or the file isn't executable → re-check the cli.ts template.
- An import error → check `package.json` "type": "module" and `tsconfig.json` "module": "NodeNext".

### 6. (Optional) Live connectivity test

Only if the user has real credentials and asks for it:

```bash
export <SVC>_TOKEN="..."
node dist/cli.js --action <first-action> --params '<real-params>'
```

Expect: `status: "success"` with shaped data. If you get `AUTH_ERROR`, the token is wrong; if `NOT_FOUND`, the resource id doesn't exist; if `CONNECTION_ERROR`, the API is unreachable.

## Verification of the skill itself (not a scaffold)

Separate from per-scaffold verification, the skill itself should be sanity-checked periodically:

1. Open `SKILL.md`, confirm < 500 lines and frontmatter is well-formed.
2. Spot-check that all referenced files in `references/*.md` exist.
3. Run the eval set in `evals/evals.json` through skill-creator's eval loop (see `~/.claude/plugins/cache/claude-plugins-official/skill-creator/`).
4. After a major scaffold change, manually run test case 1 (Stripe) and `diff` the resulting tree against `notion-agent-connector/` (ignoring service-name substitutions).
