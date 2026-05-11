# Task 12: SKILL.md + plugin README

Update the plugin's user-facing docs to reflect the expanded write surface and the `require_draft_pr` knob.

**Files:**
- Modify: `plugins/github-agent/skills/github-agent/SKILL.md`
- Modify: `plugins/github-agent/README.md`

- [ ] **Step 1: Rewrite `SKILL.md`**

Overwrite `plugins/github-agent/skills/github-agent/SKILL.md` with:

```md
---
name: github-agent
description: |
  Use when the user asks about GitHub data or wants to act on GitHub —
  repository info, code search, issue/PR/release/workflow inspection,
  or any write that creates, updates, closes, or deletes a PR, issue,
  comment, or release; merging PRs (admin); and managing Actions
  workflow runs (rerun / cancel / dispatch).
context: fork
---

# GitHub Agent

Answer the user's question by invoking the `github-agent` binary
exposed by this plugin. It delegates to `narai-primitives/github`
via GitHub's REST v3 + GraphQL APIs.

## Invocation

```
github-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Read actions

| Action | Required params |
|---|---|
| `repo_info` | `owner`, `repo` |
| `search_code` | `owner`, `repo`, `query`, optional `max_results` |
| `get_issues` | `owner`, `repo`, optional `state`, `labels`, `max_results` |
| `get_pulls` | `owner`, `repo`, optional `state`, `max_results` |
| `get_pull_request` | `owner`, `repo`, `pull_number` |
| `get_issue` | `owner`, `repo`, `issue_number` |
| `get_file` | `owner`, `repo`, `path`, optional `ref` |
| `get_issue_comments` | `owner`, `repo`, `issue_number` |
| `get_pr_review_comments` | `owner`, `repo`, `pr_number` |
| `list_release_assets` | `owner`, `repo`, `tag` |
| `get_release_asset` | `owner`, `repo`, `asset_id` |
| `list_workflow_runs` | `owner`, `repo`, optional `branch`/`event`/`status`/`head_sha` |
| `get_workflow_run` | `owner`, `repo`, `run_id` |
| `list_workflow_run_jobs` | `owner`, `repo`, `run_id` |
| `get_workflow_run_logs` | `owner`, `repo`, `run_id` — returns redirect URL, not the ZIP body |

## Write actions (escalate by default)

| Action | Required params |
|---|---|
| `create_pull_request` | `owner`, `repo`, `title`, `head`, `base`, optional `body`/`draft` |
| `update_pull_request` | `owner`, `repo`, `pull_number`, optional `title`/`body`/`base`/`state=open` |
| `close_pull_request` | `owner`, `repo`, `pull_number` |
| `create_issue` | `owner`, `repo`, `title`, optional `body`/`labels`/`assignees` |
| `update_issue` | `owner`, `repo`, `issue_number`, optional `title`/`body`/`labels`/`state=open` |
| `close_issue` | `owner`, `repo`, `issue_number`, optional `state_reason` |
| `add_issue_comment` | `owner`, `repo`, `issue_number`, `body` |
| `update_issue_comment` | `owner`, `repo`, `comment_id`, `body` |
| `delete_issue_comment` | `owner`, `repo`, `comment_id` |
| `add_pr_review_comment` | `owner`, `repo`, `pr_number`, `body`, `commit_id`, `path`, `line` |
| `update_pr_review_comment` | `owner`, `repo`, `comment_id`, `body` |
| `delete_pr_review_comment` | `owner`, `repo`, `comment_id` |
| `create_release` | `owner`, `repo`, `tag_name`, optional `name`/`body`/`draft`/`prerelease` |
| `update_release` | `owner`, `repo`, `release_id`, optional fields |
| `delete_release` | `owner`, `repo`, `release_id` |
| `delete_release_asset` | `owner`, `repo`, `asset_id` |
| `rerun_workflow_run` | `owner`, `repo`, `run_id` |
| `rerun_failed_jobs` | `owner`, `repo`, `run_id` |
| `cancel_workflow_run` | `owner`, `repo`, `run_id` |
| `trigger_workflow_dispatch` | `owner`, `repo`, `workflow_id_or_filename`, `ref`, optional `inputs` |

## Admin actions (denied by default — operator must opt in)

| Action | Required params |
|---|---|
| `merge_pull_request` | `owner`, `repo`, `pull_number`, `merge_method` ∈ {merge, squash, rebase} |

To enable `merge_pull_request`, set `policy.admin: escalate` in
`~/.github-agent/config.yaml` (or the repo-level overlay).

## Credentials

Set `GITHUB_TOKEN` to a PAT with:
- `repo` — read + write on code, issues, PRs, comments, releases
- `workflow` — required for `rerun_*`, `cancel_workflow_run`, and
  `trigger_workflow_dispatch`

## Config

`~/.github-agent/config.yaml` (user-level) merges with
`<cwd>/.github-agent/config.yaml` (repo overlay). Beyond the toolkit's
standard `policy` and `approval_mode` keys, the connector reads:

```yaml
github:
  require_draft_pr: true     # forces every create_pull_request to draft=true
```

This can be overridden at runtime by `GITHUB_REQUIRE_DRAFT_PR=1` (or 0).

## Safety

Every write call goes through the toolkit's policy gate. With no
operator config, writes escalate (asking once), deletes escalate with a
`delete` aspect for audit, and admin actions are denied until the
operator explicitly opts in via YAML. The `delete` aspect is floored —
operator config cannot downgrade it to `success`.
```

- [ ] **Step 2: Update `plugins/github-agent/README.md`**

Read the current `plugins/github-agent/README.md` and replace its body with:

```md
# github-agent plugin

Read and write GitHub data — repository info, code search, issues,
pull requests, comments, releases, and Actions workflows — through the
narai-primitives connector toolkit's policy gate.

## Credentials

Set `GITHUB_TOKEN` to a PAT.

| Scope | Why |
|---|---|
| `repo` | Read + write on issues, PRs, comments, releases, file contents |
| `workflow` | Required for Actions writes (`rerun_*`, `cancel_workflow_run`, `trigger_workflow_dispatch`) |

Tokens without `workflow` will see `AUTH_ERROR` with a scope hint
when invoking Actions-write endpoints.

## Config

Place YAML at `~/.github-agent/config.yaml` (user-level) or
`<cwd>/.github-agent/config.yaml` (repo overlay). Repo overlay wins on
collisions.

```yaml
policy:
  read: success
  write: escalate
  admin: escalate              # enables merge_pull_request
  aspects:
    delete: escalate            # cannot be set to success — floored
approval_mode: confirm_once
github:
  require_draft_pr: true       # forces every create_pull_request to draft=true
```

Runtime override: `GITHUB_REQUIRE_DRAFT_PR=1` forces drafts even when
the YAML says false; `GITHUB_REQUIRE_DRAFT_PR=0` forces non-drafts.
Invalid values throw at startup.

## Action surface

36 actions across reads (15), writes (20), and admin (1). See
`skills/github-agent/SKILL.md` for the full table.

## License

See repo root.
```

- [ ] **Step 3: Verify docs render and link to nothing broken**

Skim both files for stale references (e.g., "read-only", "Never modifies"). Run:

```
grep -n "read-only\|Never modifies" plugins/github-agent/
```
Expected: no matches.

- [ ] **Step 4: Commit**

```
git add plugins/github-agent/skills/github-agent/SKILL.md plugins/github-agent/README.md
git commit -m "docs(github): rewrite SKILL.md + README for write actions

Removes the read-only / 'Never modifies' framing. Documents all 36
actions, the require_draft_pr config knob (YAML + env), and the
~/.github-agent/config.yaml schema for opting into merge_pull_request."
```
