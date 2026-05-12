# GitLab connector — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `src/connectors/gitlab/` and `plugins/gitlab-connector/` mirroring the 36-action github-connector (PR #20), with GitLab-native terminology and 33 actions (14 read + 18 write + 1 admin).

**Architecture:** Identical structure to github-connector: per-domain action modules under `actions/`, shared `_fields.ts` + `_pagination.ts` + `_types.ts`, behavior config loader, policy gate with delete-aspect floor. Auth via `Authorization: Bearer <PAT>` (GitLab ≥12.x).

**Tech Stack:** TypeScript (strict, ESM), Zod 3, Vitest, `narai-primitives/toolkit`.

**Spec:** `docs/superpowers/specs/2026-05-12-gitlab-connector-design.md`.

---

## File map

**New source files (13):**
- `src/connectors/gitlab/index.ts`
- `src/connectors/gitlab/cli.ts`
- `src/connectors/gitlab/actions/_fields.ts`
- `src/connectors/gitlab/actions/_pagination.ts`
- `src/connectors/gitlab/actions/_types.ts`
- `src/connectors/gitlab/actions/reads.ts`
- `src/connectors/gitlab/actions/merges.ts`
- `src/connectors/gitlab/actions/issues.ts`
- `src/connectors/gitlab/actions/notes.ts`
- `src/connectors/gitlab/actions/releases.ts`
- `src/connectors/gitlab/actions/pipelines.ts`
- `src/connectors/gitlab/lib/gitlab_client.ts`
- `src/connectors/gitlab/lib/gitlab_config.ts`

**New plugin files (8):**
- `plugins/gitlab-connector/.claude-plugin/plugin.json`
- `plugins/gitlab-connector/bin/gitlab-connector`
- `plugins/gitlab-connector/commands/gitlab-connector.md`
- `plugins/gitlab-connector/hooks/hooks.json`
- `plugins/gitlab-connector/package.json`
- `plugins/gitlab-connector/plugin-config.json`
- `plugins/gitlab-connector/README.md`
- `plugins/gitlab-connector/skills/gitlab-connector/SKILL.md`

**New test files (10):**
- `tests/connectors/gitlab/unit/cli.test.ts`
- `tests/connectors/gitlab/unit/gitlab_client_extras.test.ts`
- `tests/connectors/gitlab/unit/gitlab_client_mutations.test.ts`
- `tests/connectors/gitlab/unit/gitlab_config.test.ts`
- `tests/connectors/gitlab/unit/actions_merges.test.ts`
- `tests/connectors/gitlab/unit/actions_issues.test.ts`
- `tests/connectors/gitlab/unit/actions_notes.test.ts`
- `tests/connectors/gitlab/unit/actions_releases.test.ts`
- `tests/connectors/gitlab/unit/actions_pipelines.test.ts`
- `tests/connectors/gitlab/integration/framework.test.ts`

**Modified:**
- `package.json` (exports + bin)
- `README.md` (bundle table)
- `CONTRIBUTING.md` (bundled-builtins list)
- `/Users/narayan/src/narai-claude-plugins/.claude-plugin/marketplace.json` (separate repo)

---

## Tasks

Each task is TDD: failing tests first → minimal impl → tests pass → commit. Run `npx vitest run tests/connectors/gitlab` for fast feedback.

### Task 1 — Behavior config loader

`src/connectors/gitlab/lib/gitlab_config.ts` exposes `loadGitlabBehavior({ cwd, home, env })` returning `{ requireDraftMr, host }`. Precedence: env > repo YAML > user YAML > default. Tests cover the 14-case precedence matrix for both knobs.

**Files:** `lib/gitlab_config.ts`, `tests/connectors/gitlab/unit/gitlab_config.test.ts`.

**Pattern reference:** `src/connectors/github/lib/github_config.ts`.

### Task 2 — GitlabClient + credentials

`src/connectors/gitlab/lib/gitlab_client.ts`:
- `loadGitlabCredentials()` reads `GITLAB_TOKEN`, `GITLAB_HOST` (default `https://gitlab.com`), optional `GITLAB_NAMESPACE`.
- `GitlabClient` constructor takes `{ token, host, defaultNamespace, ... }`. baseUrl = `${host}/api/v4`. Auth header: `Bearer <token>`.
- Methods (HTTP-level only): mirror github_client.ts methods 1:1 where they exist; for unified notes one method `getNotes(projectPath, noteableType, iid)`; for pipelines: `getPipeline`, `listPipelines(query)`, `listPipelineJobs(pipelineId)`, `getJobLogs(jobId)`, `retryPipeline`, `cancelPipeline`, `triggerPipeline(ref, token)`, `playJob(jobId)`, `retryFailedJobs(pipelineId)` (uses /retry endpoint scoped to failed).
- `projectPath(namespace, project)` helper: returns `encodeURIComponent(`${namespace}/${project}`)`.
- Extras tests in `gitlab_client_extras.test.ts` cover retry/timeout/rate-limit.

**Files:** `lib/gitlab_client.ts`, `tests/connectors/gitlab/unit/gitlab_client_extras.test.ts` (+ `gitlab_client_mutations.test.ts` grows in later tasks).

**Pattern reference:** `src/connectors/github/lib/github_client.ts`, `tests/connectors/github/unit/github_client_extras.test.ts`.

### Task 3 — Shared utilities + 14 read actions

`actions/_fields.ts` exports zod schemas: `namespaceField`, `projectField` (combined into `projectInputSchema = z.object({ namespace, project })`), `mrIidField`, `issueIidField`, `pipelineIdField`, `jobIdField`, `noteIdField`, `releaseTagField`, `linkIdField`, `refField`, `shaField`, `filePathField`.

`actions/_pagination.ts` exports `paginateGitlab<T>(maxResults, fetchPage)` using `X-Next-Page` / `X-Total-Pages` headers (per `HttpResultOk.headers` — confirm shape).

`actions/_types.ts` exports `GitlabActions`, `GitlabActionDeps`.

`actions/reads.ts` defines `buildReadActions(deps)` with the 14 read actions (envelope shapes documented in spec §3.1).

Tests in `actions_*` files exist by domain even though reads is one file — these classification + envelope tests live in `actions_merges.test.ts`, `actions_issues.test.ts`, etc. for the domain reads; pure-read actions (`project_info`, `search_code`, `get_file`, `list_pipelines`, etc.) get a `actions_reads.test.ts` file.

**Files:** `actions/{_fields,_pagination,_types,reads}.ts`, `tests/connectors/gitlab/unit/actions_reads.test.ts`.

**Pattern reference:** `src/connectors/github/actions/{_fields,_pagination,_types,reads}.ts`.

### Task 4 — MR actions module (merges.ts)

5 actions: `create_merge_request` (honors `require_draft_mr`), `update_merge_request` (rejects `state_event=close`), `close_merge_request` (delete aspect), `merge_merge_request` (admin, 405/406 → CONFLICT), and `get_merge_request` already in reads.

GitLab merge endpoint returns 405 or 406 when not mergeable. Handler inspects `r.status` ∈ {405, 406, 409} and throws `ConnectorError("CONFLICT", message, false)`.

**Files:** `actions/merges.ts`, `tests/connectors/gitlab/unit/actions_merges.test.ts`.

**Pattern reference:** `src/connectors/github/actions/pulls.ts` for the require_draft pattern and conflict handling.

### Task 5 — Issue actions module (issues.ts)

3 writes: `create_issue`, `update_issue` (rejects `state_event=close`), `close_issue` (delete aspect, accepts optional `state_reason`).

**Files:** `actions/issues.ts`, `tests/connectors/gitlab/unit/actions_issues.test.ts`.

**Pattern reference:** `src/connectors/github/actions/issues.ts`.

### Task 6 — Unified notes module (notes.ts)

3 writes: `add_note`, `update_note`, `delete_note`. Each takes a `noteable_type: z.enum(["issue", "merge_request"])` and `noteable_iid`. `add_note` accepts optional `position` for MR diff notes: `{ position?: { base_sha, start_sha, head_sha, position_type: "text", new_path, new_line } }`.

Routing in handler: builds the URL as `/projects/:id/{issues|merge_requests}/:iid/notes` based on `noteable_type`. Client method `addNote(projectPath, noteableType, noteableIid, body, position?)` handles the URL construction.

**Files:** `actions/notes.ts`, `tests/connectors/gitlab/unit/actions_notes.test.ts`.

**Pattern reference:** `src/connectors/github/actions/comments.ts` — but unified per spec §3.2.

### Task 7 — Release actions module (releases.ts)

4 writes: `create_release` (tag_name, name, description, ref?), `update_release`, `delete_release` (delete aspect), `delete_release_link` (delete aspect).

**Files:** `actions/releases.ts`, `tests/connectors/gitlab/unit/actions_releases.test.ts`.

**Pattern reference:** `src/connectors/github/actions/releases.ts`.

### Task 8 — Pipeline actions module (pipelines.ts)

5 writes (read pipeline actions live in reads.ts already):
- `retry_pipeline` — POST `/projects/:id/pipelines/:id/retry`
- `retry_failed_jobs` — POST `/projects/:id/pipelines/:id/retry` (GitLab's retry only re-runs failed jobs; alias for clarity)
- `cancel_pipeline` — POST `/projects/:id/pipelines/:id/cancel`
- `trigger_pipeline` — POST `/projects/:id/trigger/pipeline` with form params `token` + `ref` + `variables[]`
- `play_job` — POST `/projects/:id/jobs/:id/play` for manual stages

**Files:** `actions/pipelines.ts`, `tests/connectors/gitlab/unit/actions_pipelines.test.ts`.

**Pattern reference:** `src/connectors/github/actions/workflows.ts`.

### Task 9 — index.ts composition + CLI

`src/connectors/gitlab/index.ts` builds the connector via `createConnector<GitlabClient>({...})`:
- `name: "gitlab"`, `version: "1.0.0"`
- `scope` callback returning `${host}/${defaultNamespace}` (mirror githubScope)
- `policyFloorAspects: ["delete"]`
- `defaultPolicy: { read: "success", write: "escalate", admin: "denied", aspects: { delete: "escalate" } }`
- Compose 6 action modules via spread
- `mapError: mapHttpError(CODE_MAP)` with `CONFLICT: "VALIDATION_ERROR"` added

`src/connectors/gitlab/cli.ts` mirrors `src/connectors/github/cli.ts` (loadConnectorEnvironment).

**Files:** `index.ts`, `cli.ts`.

### Task 10 — CLI happy-path tests

`tests/connectors/gitlab/unit/cli.test.ts` — 5 happy-path tests via `c.fetch(action, params)`:
- `create_merge_request` → escalate
- `create_issue` → escalate
- `add_note` → escalate
- `create_release` → escalate
- `trigger_pipeline` → escalate

Plus basic CLI plumbing tests (validActions surface, parses params correctly, etc).

### Task 11 — Integration framework test

`tests/connectors/gitlab/integration/framework.test.ts`:
- `c.validActions.size === 33`
- spot-checks of classifications (merge admin, close_merge_request write+delete, etc.)
- merge_merge_request denied under default policy
- merge_merge_request escalates after operator YAML sets `policy.admin: escalate`
- floor rejection: operator YAML `policy.aspects.delete: success` → CONFIG_ERROR
- X-Next-Page pagination smoke test

### Task 12 — Plugin layer + package.json + marketplace

- Create `plugins/gitlab-connector/` (all 8 files)
- `package.json`:
  - Add `"./gitlab": { types: "./dist/connectors/gitlab/index.d.ts", import: "./dist/connectors/gitlab/index.js" }` to `exports`
  - Add `"gitlab-agent-connector": "./dist/connectors/gitlab/cli.js"` to `bin`
- `README.md`: add row to bundle table
- `CONTRIBUTING.md`: add `gitlab` to bundled-builtins list
- Marketplace (separate repo `/Users/narayan/src/narai-claude-plugins`): add `gitlab-connector` entry, bump version 2.8.0 → 2.9.0

---

## Out of scope (deferred to v2)

- OAuth bearer / PRIVATE-TOKEN header alternatives
- GraphQL queries
- Group-level operations
- Project mirrors, wikis, snippets, CI variables
- Pipeline trigger token management
- Release asset binary extraction (links only)
- Live integration tests with `TEST_LIVE_GITLAB=1`

---

## Verification

```bash
cd /Users/narayan/src/narai-primitives/.claude/worktrees/feat-gitlab-connector
npm run build && npm run typecheck && npx vitest run tests/connectors/gitlab
# Expected: ~145 tests pass, 0 fail
```

Adversarial review at the end of implementation: hunt for terminology slips (PR → MR), missed env vars, wrong CONFLICT codes (405/406 vs 409).
