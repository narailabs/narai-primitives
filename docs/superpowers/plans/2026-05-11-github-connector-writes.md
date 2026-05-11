# GitHub connector: writes, CI/CD, draft-PR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `src/connectors/github/` from 9 read-only actions to 36 actions covering PRs, issues, comments, releases, and Actions workflows; gate every new action through the toolkit's existing `Classification` + `PolicyRules` primitives; add a `require_draft_pr` config knob (YAML + env) that forces every `create_pull_request` to be a draft.

**Architecture:** Split actions into per-domain modules under `src/connectors/github/actions/`. Keep `lib/github_client.ts` as the single HTTP surface (cohesive — same auth, same host, same rate limiter). `index.ts` becomes a thin composer that wires `policyFloorAspects: ["delete"]` and an explicit `defaultPolicy` with `admin: "denied"` so `merge_pull_request` requires operator opt-in. A new `lib/github_config.ts` loads the `require_draft_pr` flag with env-overrides-YAML precedence.

**Tech Stack:** TypeScript (strict, ESM), Zod 3 for schemas, Vitest for tests, `narai-primitives/toolkit` for `createConnector` + `HttpClient` + `throwIfHttpError` + `mapHttpError`, `narai-primitives/credentials` for `resolveSecret`.

**Spec:** `docs/superpowers/specs/2026-05-11-github-connector-writes-design.md` (commit `5dc79fb`).

---

## File map (lock in before tasks)

**New files:**
- `src/connectors/github/lib/github_config.ts`
- `src/connectors/github/actions/reads.ts`
- `src/connectors/github/actions/pulls.ts`
- `src/connectors/github/actions/issues.ts`
- `src/connectors/github/actions/comments.ts`
- `src/connectors/github/actions/releases.ts`
- `src/connectors/github/actions/workflows.ts`
- `tests/connectors/github/unit/github_config.test.ts`
- `tests/connectors/github/unit/github_client_mutations.test.ts`
- `tests/connectors/github/unit/actions_pulls.test.ts`
- `tests/connectors/github/unit/actions_issues.test.ts`
- `tests/connectors/github/unit/actions_comments.test.ts`
- `tests/connectors/github/unit/actions_releases.test.ts`
- `tests/connectors/github/unit/actions_workflows.test.ts`

**Modified files:**
- `src/connectors/github/index.ts`
- `src/connectors/github/lib/github_client.ts`
- `tests/connectors/github/unit/cli.test.ts`
- `tests/connectors/github/integration/framework.test.ts`
- `plugins/github-connector/skills/github-connector/SKILL.md`
- `plugins/github-connector/README.md`
- `package.json`

---

Each task below is TDD: failing tests first, run-to-fail, minimal code, run-to-pass, commit. Run `npm test` from the repo root unless specified.

The plan continues in nine task documents written one at a time so each commit is independently reviewable. Tasks 1 through 13 are described in the sibling files `2026-05-11-github-connector-writes.task01.md` ... `task13.md` (one task per file). The orchestration order is:

1. **Task 1** — `task01.md` — Expand `HttpClient.allowedMethods` to include PATCH, PUT, DELETE; one regression test asserting the new methods are permitted.
2. **Task 2** — `task02.md` — `lib/github_config.ts` + `github_config.test.ts`. Precedence: env > repo YAML > user YAML > default `false`.
3. **Task 3** — `task03.md` — Create `actions/reads.ts`. Lift the 9 existing read action specs out of `index.ts` into a `buildReadActions()` factory; update `index.ts` to import-and-spread. Existing `cli.test.ts`, `github_client_extras.test.ts`, and `framework.test.ts` continue to pass unchanged.
4. **Task 4** — `task04.md` — PRs: 5 client methods (`getPull`, `createPull`, `updatePull`, `closePull`, `mergePull`), 5 zod schemas, 5 action specs in `actions/pulls.ts`. Tests in `actions_pulls.test.ts`. Includes `require_draft_pr` enforcement test and the 409-on-merge handler branch.
5. **Task 5** — `task05.md` — Issues: 4 client methods, 4 schemas, 4 action specs, tests.
6. **Task 6** — `task06.md` — Comments: 6 client methods, 6 schemas, 6 action specs, tests.
7. **Task 7** — `task07.md` — Releases: 4 client methods, 4 schemas, 4 action specs, tests.
8. **Task 8** — `task08.md` — Workflows: 8 client methods (incl. `getRunLogsRedirect` using `redirect: "manual"` to capture the 302 Location header), 8 schemas, 8 action specs, tests.
9. **Task 9** — `task09.md` — Wire `policyFloorAspects: ["delete"]` and `defaultPolicy` in `index.ts`; add framework-level test asserting an operator YAML with `policy.aspects.delete: success` is rejected at config-load.
10. **Task 10** — `task10.md` — `cli.test.ts` gains one happy-path case per new domain (`create_pull_request`, `create_issue`, `add_issue_comment`, `create_release`, `trigger_workflow_dispatch`).
11. **Task 11** — `task11.md` — `framework.test.ts` asserts `validActions.size === 36`, spot-checks classifications (`merge_pull_request.kind === "admin"`, `close_pull_request.aspects.includes("delete")`), and asserts default-policy admin call surfaces `denied`.
12. **Task 12** — `task12.md` — `SKILL.md` + plugin README rewrites: remove "read-only" framing; add write/admin action tables; document `~/.github-agent/config.yaml` `github:` section and required token scopes (`repo`, `workflow`).
13. **Task 13** — `task13.md` — Bump `package.json` to 4.0.0; bump `version` literal inside `src/connectors/github/index.ts` `createConnector(...)` from `"3.0.1"` to `"4.0.0"`; final commit.

Each task file contains: a **Files** section enumerating creates/modifies with line targets, step-by-step TDD instructions with the literal code each step must produce, exact commands with expected output, and an explicit commit at the end. No placeholders, no cross-task references for code content.
