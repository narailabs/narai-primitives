# GitLab connector — design spec

**Status:** Approved 2026-05-12. Implementation plan in `docs/superpowers/plans/2026-05-12-gitlab-connector.md`.

**Scope:** Add `src/connectors/gitlab/` mirroring the just-shipped `github-connector` (PR #20) for GitLab. Native GitLab terminology (Merge Request, Pipeline, Note, Project). 33 actions: 14 read + 18 write + 1 admin.

**Builds on:** the github-connector's architecture (per-domain action modules under `actions/`, policy gate with delete-aspect floor, behavior config loader). Cite by file path where adaptation differs from a literal copy.

---

## 1. Goals

1. Functional parity with github-connector: every github feature has a gitlab counterpart unless explicitly out of scope.
2. GitLab-native terminology in action names (`merge_request`, `pipeline`, `note`, `project`) — not github terms translated.
3. First-class self-hosted GitLab via `GITLAB_HOST` env var (default `https://gitlab.com`).
4. Same policy model: writes escalate by default, admin denied until operator opts in, delete aspect floored.

## 2. Non-goals

- OAuth bearer token auth beyond PATs (v1 uses PAT via `Authorization: Bearer <token>`; GitLab ≥12.x supports this for PATs).
- GraphQL queries (REST is fully featured for our 33 actions).
- Group-level operations (project-scoped only).
- Project mirroring, wiki, snippets, CI variables.
- Pipeline trigger token management (`trigger_pipeline` accepts a token; managing trigger tokens themselves is out of scope).
- Release asset binary extraction (GitLab releases use links, not binaries — `get_release_link` returns URL metadata only).
- Live integration tests behind `TEST_LIVE_GITLAB=1` harness.

## 3. Action surface (33 total)

### 3.1 Reads (14)

| Action | Endpoint |
|---|---|
| `project_info` | `GET /projects/:id` |
| `search_code` | `GET /projects/:id/search?scope=blobs` |
| `get_issues` | `GET /projects/:id/issues` (paginated) |
| `get_issue` | `GET /projects/:id/issues/:iid` |
| `get_merge_requests` | `GET /projects/:id/merge_requests` (paginated) |
| `get_merge_request` | `GET /projects/:id/merge_requests/:iid` |
| `get_file` | `GET /projects/:id/repository/files/:path?ref=…` |
| `get_notes` | `GET /projects/:id/{issues\|merge_requests}/:iid/notes` (unified) |
| `list_release_links` | `GET /projects/:id/releases/:tag/assets/links` |
| `get_release_link` | `GET /projects/:id/releases/:tag/assets/links/:link_id` |
| `list_pipelines` | `GET /projects/:id/pipelines` |
| `get_pipeline` | `GET /projects/:id/pipelines/:id` |
| `list_pipeline_jobs` | `GET /projects/:id/pipelines/:id/jobs` |
| `get_job_logs` | `GET /projects/:id/jobs/:id/trace` (text response, no redirect) |

### 3.2 Writes (18)

**MRs (3):** `create_merge_request` (honors `require_draft_mr`), `update_merge_request` (rejects `state_event=close`), `close_merge_request` (delete aspect).

**Issues (3):** `create_issue`, `update_issue` (rejects `state_event=close`), `close_issue` (delete aspect).

**Notes (3 unified):** `add_note`, `update_note`, `delete_note` (delete aspect). Each takes `noteable_type: "issue" | "merge_request"` + `noteable_iid`. `add_note` accepts optional position payload (commit_sha + path + line) for MR diff notes.

**Releases (4):** `create_release`, `update_release`, `delete_release` (delete aspect), `delete_release_link` (delete aspect).

**Pipelines (5):** `retry_pipeline`, `retry_failed_jobs`, `cancel_pipeline`, `trigger_pipeline` (token+ref), `play_job` (manual stage trigger).

### 3.3 Admin (1)

| Action | Endpoint |
|---|---|
| `merge_merge_request` | `PUT /projects/:id/merge_requests/:iid/merge`. Returns 405/406 on conflict — mapped to `VALIDATION_ERROR` via a `CONFLICT` code in CODE_MAP, mirroring github's 409 handling. Denied by default until operator sets `policy.admin: escalate` in `~/.gitlab-connector/config.yaml`. |

## 4. Architecture

Mirror `src/connectors/github/` exactly:

```
src/connectors/gitlab/
  index.ts                    — factory; policyFloorAspects + defaultPolicy + composes 6 action modules
  cli.ts                      — narai-primitives/config wiring
  actions/
    _fields.ts                — zod schemas: namespaceField, projectField, mrIidField, issueIidField, pipelineIdField, jobIdField, refField, shaField, noteIdField, releaseTagField, linkIdField
    _pagination.ts            — GitLab REST pagination via X-Next-Page header
    _types.ts                 — GitlabActions, GitlabActionDeps
    reads.ts                  — 14 read actions
    merges.ts                 — 5 MR actions (incl. admin merge)
    issues.ts                 — 4 issue actions
    notes.ts                  — 3 unified note actions
    releases.ts               — 4 release actions
    pipelines.ts              — 9 pipeline actions
  lib/
    gitlab_client.ts          — HTTP client with configurable baseUrl, Bearer auth
    gitlab_config.ts          — loadGitlabBehavior() → { requireDraftMr, host }
```

## 5. Auth & client

`loadGitlabCredentials()` resolution (each step):
1. `await resolveSecret("GITLAB_TOKEN")`
2. `process.env.GITLAB_TOKEN`

Same chain for `GITLAB_HOST` (default `https://gitlab.com`) and optional `GITLAB_NAMESPACE`.

Auth: `Authorization: Bearer <token>`. Works for PATs on GitLab ≥12.x (the supported floor) and OAuth2 tokens.

Client wraps the shared toolkit `HttpClient` with `allowedMethods: {GET, POST, PUT, PATCH, DELETE}` and `baseUrl: <host>/api/v4`.

## 6. Behavior config

`~/.gitlab-connector/config.yaml` (user) merges with `<cwd>/.gitlab-connector/config.yaml` (repo overlay):

```yaml
gitlab:
  require_draft_mr: true       # forces draft: true on every create_merge_request
  host: https://gitlab.mycorp  # overrides default https://gitlab.com
```

Env overrides:
- `GITLAB_REQUIRE_DRAFT_MR` (1/0/true/false/yes/no/empty)
- `GITLAB_HOST`

Precedence (highest first): env > repo YAML > user YAML > default.

## 7. Policy wiring

```ts
policyFloorAspects: ["delete"],
defaultPolicy: {
  read: "success",
  write: "escalate",
  admin: "denied",
  aspects: { delete: "escalate" },
},
```

Identical to github-connector's. `merge_merge_request` is denied until operator opts in.

## 8. Plugin layer

Mirror `plugins/github-connector/` shape under `plugins/gitlab-connector/`:
- `.claude-plugin/plugin.json` — name `gitlab-connector-plugin`, version `1.0.0`
- `bin/gitlab-connector` — bash exec shim
- `commands/gitlab-connector.md`
- `skills/gitlab-connector/SKILL.md` — frontmatter description + action tables + safety section
- `hooks/hooks.json` — `USAGE_CONNECTOR_NAME=gitlab`
- `package.json`, `plugin-config.json`, `README.md`

## 9. Tests

`tests/connectors/gitlab/`:
- `unit/cli.test.ts` — 5 happy-path CLI invocations (write actions escalate by default)
- `unit/gitlab_client_extras.test.ts` — retry/timeout/rate-limit (mirror github_client_extras pattern)
- `unit/gitlab_client_mutations.test.ts` — one test per client method
- `unit/gitlab_config.test.ts` — 14-case YAML+env precedence for both require_draft_mr AND host
- `unit/actions_merges.test.ts` — 5 MR actions + classification + require_draft_mr enforcement + 405/406 conflict
- `unit/actions_issues.test.ts` — issue actions
- `unit/actions_notes.test.ts` — 3 unified note actions across both noteable_type variants
- `unit/actions_releases.test.ts`
- `unit/actions_pipelines.test.ts` — 9 pipeline actions
- `integration/framework.test.ts` — 33-action surface, policy floors, admin opt-in flow

Expected count: ~145 tests proportionate to github's 189 (smaller because of notes consolidation).

## 10. Files modified outside the connector

| File | Change |
|---|---|
| `package.json` | Add `"./gitlab"` to `exports`; add `"gitlab-agent-connector": "./dist/connectors/gitlab/cli.js"` to `bin` (keep `-agent-connector` npm convention) |
| `README.md` | Add `narai-primitives/gitlab` row to the bundle table |
| `CONTRIBUTING.md` | Add `gitlab` to the list of bundled builtins |
| `narai-claude-plugins/.claude-plugin/marketplace.json` | Add `gitlab-connector` entry; bump `metadata.version` 2.8.0 → 2.9.0 |

## 11. Reused patterns from github-connector (cite by path)

- `src/connectors/github/index.ts` — factory composition + CODE_MAP + 409 handling pattern (adapt to 405/406)
- `src/connectors/github/actions/pulls.ts` — action module factory shape + require_draft_pr enforcement (mirror for require_draft_mr)
- `src/connectors/github/actions/_fields.ts` — shared zod schemas
- `src/connectors/github/actions/_pagination.ts` — pagination generic (different header name for GitLab)
- `src/connectors/github/lib/github_config.ts` — env+YAML precedence loader
- `src/connectors/github/lib/github_client.ts` — HTTP client wrapping HttpClient
- `plugins/github-connector/` — plugin layer template
- `tests/connectors/github/integration/framework.test.ts` — policy gate integration test patterns

## 12. Architecture invariants

Reviewed against `docs/architecture-invariants.md`. New connector follows existing patterns:
- Bundled CLI at `dist/connectors/gitlab/cli.js` — resolver auto-discovers via `bundled-self` step
- `plugins/gitlab-connector/skills/gitlab-connector/SKILL.md` — hub's `skillMdCandidates` auto-derives this path
- No optional peer dependencies — uses built-in `fetch` (same as github)
- Not a db connector — schema dispatch not relevant

No invariant-path file is touched.
