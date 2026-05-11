# Task 13: Version bump

Bump the connector version 3.0.1 → 4.0.0 in `package.json` and inside `createConnector(...)`'s `version` literal.

**Files:**
- Modify: `package.json`
- Modify: `src/connectors/github/index.ts`

- [ ] **Step 1: Bump `package.json`**

Open `package.json`, find the top-level `"version": "3.0.1"` (or whatever the current bundle version is), and bump it to `"4.0.0"`.

Note: if the bundle's `package.json` carries a single bundled version and `github` is just one of many connectors, prefer instead to bump only the connector's `version` literal in `index.ts` (Step 2) and leave the bundle `package.json` alone — confirm with the maintainer in the PR description.

If the project's release process uses a single bundle version (look at `CONTRIBUTING.md` "Releasing" section), do bump `package.json`.

- [ ] **Step 2: Bump the connector's version literal**

Open `src/connectors/github/index.ts`. Find:

```ts
    version: "3.0.1",
```

Replace with:

```ts
    version: "4.0.0",
```

- [ ] **Step 3: Run the full suite end-to-end**

```
npm run typecheck && npm test
```
Expected: all passing.

- [ ] **Step 4: Verify no doc strings reference the old version**

```
grep -n "3.0.1" src/connectors/github/ plugins/github-agent/
```
Expected: no matches (or only matches in unrelated context).

- [ ] **Step 5: Commit**

```
git add package.json src/connectors/github/index.ts
git commit -m "chore(github): bump connector version to 4.0.0

Major bump: adds write + admin actions (denied by default), removes
the 'read-only' framing from SKILL.md, and introduces the
require_draft_pr config knob. Callers relying on read-only safety
must now rely on the policy gate."
```

- [ ] **Step 6: Final review pass — verify the integration count and run the doc-wiki evals if your change touched invariant paths**

```
npm test -- --reporter=verbose 2>&1 | grep -E "(passed|failed|tests)"
```

Per `docs/architecture-invariants.md`, this work did not touch any of the four invariant paths (resolver, hub prepareConnector, lazy-loading guards, db schema dispatch). So `eval-14` / `eval-20` runs are not required for this change.

- [ ] **Step 7: Open the PR**

Use the `commit-commands:commit-push-pr` skill or manually push and open a PR with:

```
git push -u origin <branch>
gh pr create --title "feat(github): writes, CI/CD, draft-PR enforcement (v4)" \
  --body "$(cat <<'EOF'
## Summary
- 27 new actions: PRs, issues, comments, releases, Actions workflows
- New \`require_draft_pr\` config (YAML + env override) forces drafts on create_pull_request
- merge_pull_request classified \`admin\` — denied by default, operator opts in via YAML
- delete aspect floored — cannot be downgraded to success by operator config
- Action layer split into per-domain modules under \`src/connectors/github/actions/\`

## Spec
\`docs/superpowers/specs/2026-05-11-github-connector-writes-design.md\`

## Test plan
- [x] \`npm test\` passes
- [x] \`npm run typecheck\` passes
- [x] github unit + integration tests cover the 27 new actions
- [x] No regression on the 9 existing read actions
- [x] Connector exposes 36 actions total (locked in by framework.test.ts)

## Breaking changes
- Connector version 3.0.1 → 4.0.0
- SKILL.md no longer claims read-only
- Tokens previously sufficient for reads need \`repo\` (writes) and \`workflow\` (Actions writes)
- \`merge_pull_request\` requires \`policy.admin: escalate\` in \`~/.github-agent/config.yaml\`
EOF
)"
```
