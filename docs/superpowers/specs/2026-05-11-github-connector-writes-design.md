# GitHub connector: writes, CI/CD, and draft-PR enforcement

**Status:** Design approved 2026-05-11. Implementation plan to follow.
**Scope:** Extend `src/connectors/github/` from 9 read-only actions to 36 actions covering pull-request, issue, comment, release, and Actions-workflow management, gated by the toolkit's existing policy + approval-mode primitives. Adds a `require_draft_pr` config knob that forces every `create_pull_request` to be a draft.

---

## 1. Goals

1. Mirror the write surface that Linear, Jira, Notion, and Confluence already expose, so GitHub stops being the only read-only builtin.
2. Cover CI/CD workflow management at the granularity needed for "what's failing on this PR, can you re-run it" — without admitting fork-PR approval or run deletion (admin-only).
3. Let operators opt into a "draft-PR floor" so any agent-initiated `create_pull_request` is non-mergeable until a human flips it to ready-for-review.
4. Gate every new action through the toolkit's existing `Classification` → `PolicyRules` → `Decision` flow. No new gate mechanism is introduced.

## 2. Non-goals

- Asset upload to `uploads.github.com` (multipart, separate host, large payloads). Deferred.
- Hard delete of PRs/issues via GraphQL `deletePullRequest` / `deleteIssue` mutations (admin-only). Deferred.
- Approving fork-PR workflow runs and deleting workflow runs (admin). Deferred.
- Branch protection / required-status-checks management (admin). Deferred.
- A new live-tests harness. The existing `tests/connectors/github/live/` directory stays as-is.

## 3. Action surface

27 new actions across 5 domains. The 9 existing read actions are kept unchanged but relocated.

### 3.1 Pull requests (5 new)

| Action | Kind | Aspects | Endpoint |
|---|---|---|---|
| `get_pull_request` | `read` | — | `GET /repos/{o}/{r}/pulls/{n}` |
| `create_pull_request` | `write` | — | `POST /repos/{o}/{r}/pulls` (draft enforced by config — see §6) |
| `update_pull_request` | `write` | — | `PATCH /repos/{o}/{r}/pulls/{n}` — rejects `state=closed` at the schema level |
| `close_pull_request` | `write` | `["delete"]` | `PATCH /repos/{o}/{r}/pulls/{n}` with `state=closed` |
| `merge_pull_request` | `admin` | — | `PUT /repos/{o}/{r}/pulls/{n}/merge` with `merge_method` ∈ {merge, squash, rebase} |

Rationale: `update_pull_request` rejects `state=closed` so that closure is always a dedicated, separately-classifiable action carrying the `delete` aspect. Reopening (`state=open`) stays in `update_pull_request` because it is not destructive.

### 3.2 Issues (4 new)

| Action | Kind | Aspects |
|---|---|---|
| `get_issue` | `read` | — |
| `create_issue` | `write` | — |
| `update_issue` | `write` | — (rejects `state=closed`) |
| `close_issue` | `write` | `["delete"]` |

Same closure-as-delete-aspect pattern as PRs.

### 3.3 Comments (6 new)

Two distinct GitHub APIs are exposed: issue-conversation comments and PR review-inline comments.

| Action | Kind | Aspects | Endpoint |
|---|---|---|---|
| `add_issue_comment` | `write` | — | `POST /repos/{o}/{r}/issues/{n}/comments` |
| `update_issue_comment` | `write` | — | `PATCH /repos/{o}/{r}/issues/comments/{id}` |
| `delete_issue_comment` | `write` | `["delete"]` | `DELETE /repos/{o}/{r}/issues/comments/{id}` |
| `add_pr_review_comment` | `write` | — | `POST /repos/{o}/{r}/pulls/{n}/comments` (requires commit_id + path + line) |
| `update_pr_review_comment` | `write` | — | `PATCH /repos/{o}/{r}/pulls/comments/{id}` |
| `delete_pr_review_comment` | `write` | `["delete"]` | `DELETE /repos/{o}/{r}/pulls/comments/{id}` |

The existing `get_issue_comments` and `get_pr_review_comments` reads stay as-is.

### 3.4 Releases (4 new)

| Action | Kind | Aspects |
|---|---|---|
| `create_release` | `write` | — (tag_name, name, body, draft, prerelease, target_commitish) |
| `update_release` | `write` | — |
| `delete_release` | `write` | `["delete"]` |
| `delete_release_asset` | `write` | `["delete"]` |

Asset upload is out of scope. `list_release_assets` and `get_release_asset` reads stay.

### 3.5 Workflows / Actions (8 new)

| Action | Kind | Endpoint |
|---|---|---|
| `list_workflow_runs` | `read` | `GET /repos/{o}/{r}/actions/runs` — filters: branch, status, event, head_sha (supports "runs for this PR" via head_sha) |
| `get_workflow_run` | `read` | `GET /repos/{o}/{r}/actions/runs/{id}` |
| `list_workflow_run_jobs` | `read` | `GET /repos/{o}/{r}/actions/runs/{id}/jobs` |
| `get_workflow_run_logs` | `read` | `GET /repos/{o}/{r}/actions/runs/{id}/logs` — captures the 302 `Location` header and returns `{ url, expires_at_estimate }`; the ZIP body is not downloaded through the connector. The client method calls fetch with `redirect: "manual"` and reads the `Location` header. |
| `rerun_workflow_run` | `write` | `POST /repos/{o}/{r}/actions/runs/{id}/rerun` |
| `rerun_failed_jobs` | `write` | `POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs` |
| `cancel_workflow_run` | `write` | `POST /repos/{o}/{r}/actions/runs/{id}/cancel` |
| `trigger_workflow_dispatch` | `write` | `POST /repos/{o}/{r}/actions/workflows/{workflow_id_or_filename}/dispatches` — accepts a `ref` and an `inputs` map |

## 4. File layout

### 4.1 New files

```
src/connectors/github/
  actions/
    reads.ts          — the 9 existing read action specs, lifted out of index.ts
    pulls.ts          — 5 PR actions
    issues.ts         — 4 issue actions
    comments.ts       — 6 comment actions
    releases.ts       — 4 release actions
    workflows.ts      — 8 workflow actions
  lib/
    github_config.ts  — loadGithubBehavior(): { requireDraftPr } from YAML + env
```

Each action module exports a factory `buildXActions(deps)` returning `Record<string, ActionSpec>`. Cross-cutting dependencies (behavior config, the toolkit's `throwIfHttpError`) are passed in, not imported at module scope, so action modules stay leaf-only with no circular risk.

### 4.2 Modified files

| File | Change |
|---|---|
| `src/connectors/github/index.ts` | Shrinks to ~120 lines. Composes the 6 action modules into a single `actions` map. Wires `policyFloorAspects: ["delete"]` and an explicit `defaultPolicy` (see §5). Keeps `githubScope`, `BuildOptions`, default exports. |
| `src/connectors/github/lib/github_client.ts` | Adds ~17 mutation methods (one per new endpoint). Expands `allowedMethods` from `{GET, POST}` to `{GET, POST, PATCH, PUT, DELETE}`. |
| `src/connectors/github/cli.ts` | No change. |
| `plugins/github-agent/skills/github-agent/SKILL.md` | Rewrite: remove "read-only" / "Never modifies GitHub". Add write- and admin-action tables. Add a safety paragraph pointing operators at `~/.github-agent/config.yaml`. |
| `plugins/github-agent/README.md` | Document the new token scopes (`repo` write, `workflow`) and the `require_draft_pr` config knob. |
| `package.json` | Version bump 3.0.1 → 4.0.0 (semver major; admin actions added, denied by default; SKILL.md framing changed). |

### 4.3 Test files (new)

```
tests/connectors/github/unit/
  actions_pulls.test.ts
  actions_issues.test.ts
  actions_comments.test.ts
  actions_releases.test.ts
  actions_workflows.test.ts
  github_config.test.ts
  github_client_mutations.test.ts
```

### 4.4 Test files (modified)

| File | Edit |
|---|---|
| `tests/connectors/github/unit/cli.test.ts` | Add one happy-path CLI case per new domain (5 new cases). |
| `tests/connectors/github/integration/framework.test.ts` | Assert all 36 actions exposed in `validActions`; assert classifications by spot-check; assert `policyFloorAspects` rejects an operator YAML setting `policy.aspects.delete: success`. |

## 5. Policy wiring

### 5.1 Defaults declared on the connector

```ts
return createConnector<GithubClient>({
  name: "github",
  version: "4.0.0",
  policyFloorAspects: ["delete"],
  defaultPolicy: {
    read: "success",
    write: "escalate",
    admin: "denied",
    aspects: { delete: "escalate" },
  },
  // ...rest unchanged
});
```

### 5.2 Effective behavior with no operator config

| Action class | Decision |
|---|---|
| Reads (`get_*`, `list_*`, `search_code`) | `success` — auto-allowed |
| Writes (`create_*`, `update_*`, `add_*`, `trigger_*`, `rerun_*`, `cancel_*`) | `escalate` — every call asks |
| Writes with `delete` aspect (`close_*`, `delete_*_comment`, `delete_release*`) | `escalate`, reason string carries the aspect for audit visibility |
| Admin (`merge_pull_request`) | `denied` — operator must opt in |

### 5.3 Operator YAML knobs

`~/.github-agent/config.yaml` (user-level) is merged with `<cwd>/.github-agent/config.yaml` (repo-level overlay). The toolkit's `validatePolicyConfig` already permits unknown top-level keys to pass through, so the new `github:` section coexists with the existing `policy:` and `approval_mode:` keys.

```yaml
policy:
  read: success
  write: escalate
  admin: escalate        # enables merge_pull_request
  aspects:
    delete: escalate     # cannot be "success" — floored
approval_mode: confirm_once
github:
  require_draft_pr: true
```

Floors enforced at config-load time:
- `policy.aspects.delete: success` → rejected (`policyFloorAspects: ["delete"]`).
- `policy.admin: success` → rejected by the toolkit's type-level `RestrictedRule`.

## 6. `require_draft_pr` config

### 6.1 Precedence

Highest wins:

1. `GITHUB_REQUIRE_DRAFT_PR` env var — `"1"`/`"true"`/`"yes"` → true; `"0"`/`"false"`/`"no"`/empty → false; any other value throws `CONFIG_ERROR` at startup.
2. `<cwd>/.github-agent/config.yaml` `github.require_draft_pr`.
3. `~/.github-agent/config.yaml` `github.require_draft_pr`.
4. Default: `false`.

### 6.2 Loader

`src/connectors/github/lib/github_config.ts` exports:

```ts
export interface GithubBehavior {
  requireDraftPr: boolean;
}

export function loadGithubBehavior(opts?: {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): GithubBehavior;
```

The loader replicates the toolkit's `discoverConfigPaths` + `deepMerge` + `readYaml` pattern locally (~15 lines) rather than importing toolkit internals — those helpers are not exported and the duplication is bounded.

### 6.3 Enforcement

`create_pull_request` handler:

```ts
const requestedDraft = p.draft ?? false;
const draftToUse = behavior.requireDraftPr ? true : requestedDraft;
const result = await ctx.sdk.createPull(/* ... */, { draft: draftToUse });
return {
  number: pr.number,
  draft: pr.draft,
  draft_forced_by_config: behavior.requireDraftPr && !requestedDraft,
  // ...
};
```

The override is surfaced in the envelope (`draft_forced_by_config: true`). No silent rewriting.

## 7. Error mapping

The existing `CODE_MAP` in `src/connectors/github/index.ts` covers most surfaces. One addition:

| Scenario | HTTP code | Mapping |
|---|---|---|
| `merge_pull_request` when head SHA changed mid-merge | `409` | Add `CONFLICT → VALIDATION_ERROR` |

All other mutation error codes (`401`, `403`, `404`, `422`, `429`, `5xx`) already map via existing entries. `mapHttpError` from the toolkit handles the conversion.

A scope-aware error message is added inside `mapError` for `403` responses: when the request URL contains `/actions/`, the message gains a hint like `"GitHub returned 403 — token may be missing the 'workflow' scope"`.

## 8. Test strategy

### 8.1 Unit

- Per action module: schema rejects malformed input; `classify` returns the expected kind+aspects; handler calls the right client method with the right shape; handler maps the response to the documented envelope. Fakes injected via `BuildOptions.sdk`.
- `github_config.test.ts`: 12-case precedence matrix (4 sources × {present, absent}); invalid env value throws; user → repo overlay merge.
- `github_client_mutations.test.ts`: one test per new method asserts URL, method, headers, body. Mirrors the existing `github_client_extras.test.ts` pattern.

### 8.2 Integration

`tests/connectors/github/integration/framework.test.ts`:
- `validActions.size === 36`.
- `actions["merge_pull_request"].classify.kind === "admin"`.
- `actions["close_pull_request"].classify.aspects.includes("delete")`.
- Operator YAML with `policy.aspects.delete: success` is rejected by config-load.
- Default-policy admin call surfaces `denied` decision without invoking the handler.

### 8.3 CLI

`tests/connectors/github/unit/cli.test.ts` adds one happy-path invocation per new domain: `create_pull_request`, `create_issue`, `add_issue_comment`, `create_release`, `trigger_workflow_dispatch`. The fake SDK is wired through the same `BuildOptions` plumbing the existing read CLI tests use.

### 8.4 Coverage

The repo enforces global v8 coverage thresholds via `npm run coverage`. Every new handler, classifier, and schema `.refine`/`.regex` rejection path must have a test. Static-analysis lazy-loading guard tests (`tests/credentials/lazy_loading.test.ts`, `tests/connectors/db/lazy_loading.test.ts`) are unaffected.

## 9. Documentation updates

| File | Edit |
|---|---|
| `plugins/github-agent/skills/github-agent/SKILL.md` | Replace "Never modifies GitHub" framing. Add write- and admin-action tables. Add a "Safety" section: writes escalate by default; admin denied until operator opts in via `~/.github-agent/config.yaml`. |
| `plugins/github-agent/README.md` | Document required token scopes (`repo` for code/issue/PR/release writes; `workflow` for Actions writes) and the `require_draft_pr` knob (YAML + env). |

## 10. Migration / breaking-change call-outs

- Connector version 3.0.1 → 4.0.0.
- `SKILL.md` no longer claims read-only. Callers relying on that line for safety must rely on the policy gate instead.
- Tokens previously valid for read-only use fail on write actions until they have the `repo` and (for Actions) `workflow` scopes. The error surfaces as `AUTH_ERROR` with a scope hint in the message.
- Operators who want `merge_pull_request` to be usable must explicitly add `policy.admin: escalate` to their `~/.github-agent/config.yaml`.

## 11. Architecture-invariants impact

Reviewed against `docs/architecture-invariants.md`:

- **Resolver `bundled-self` step:** unchanged — no new CLI file path, just additions inside the existing `cli.ts`.
- **Hub `prepareConnector`:** unchanged — no new SKILL.md path; we only edit the existing one.
- **Lazy-loading for credentials / db drivers:** N/A — GitHub uses `fetch` (built in), no optional peer deps.
- **db schema dispatch:** N/A — not a db change.

No invariant-path file is touched. The four eval-14 / eval-20 round-trip tests do not need to run for this change, but `npm test` + `npm run coverage` are still required.
