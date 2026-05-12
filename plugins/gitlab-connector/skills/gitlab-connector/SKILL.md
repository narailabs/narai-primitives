---
name: gitlab-connector
description: |
  Use when the user asks about GitLab data or wants to act on GitLab —
  project info, code search, issue/MR/release/pipeline inspection,
  or any write that creates, updates, closes, or deletes an MR, issue,
  note, or release; merging MRs (admin); and managing CI pipeline runs
  (retry / cancel / trigger / play_job).
context: fork
---

# GitLab Connector

Answer the user's question by invoking the `gitlab-connector` binary
exposed by this plugin. It delegates to `narai-primitives/gitlab`
via GitLab's REST API v4.

## Invocation

```
gitlab-connector --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Read actions

| Action | Required params |
|---|---|
| `project_info` | `namespace`, `project` |
| `search_code` | `namespace`, `project`, `query`, optional `max_results` |
| `get_issues` | `namespace`, `project`, optional `state`, `max_results` |
| `get_issue` | `namespace`, `project`, `iid` |
| `get_merge_requests` | `namespace`, `project`, optional `state`, `max_results` |
| `get_merge_request` | `namespace`, `project`, `iid` |
| `get_file` | `namespace`, `project`, `path`, optional `ref` |
| `get_notes` | `namespace`, `project`, `noteable_type` ∈ {issue, merge_request}, `noteable_iid` |
| `list_release_links` | `namespace`, `project`, `tag` |
| `get_release_link` | `namespace`, `project`, `tag`, `link_id` |
| `list_pipelines` | `namespace`, `project`, optional `ref`, `status`, `max_results` |
| `get_pipeline` | `namespace`, `project`, `pipeline_id` |
| `list_pipeline_jobs` | `namespace`, `project`, `pipeline_id` |
| `get_job_logs` | `namespace`, `project`, `job_id` |

## Write actions (escalate by default)

| Action | Required params |
|---|---|
| `create_merge_request` | `namespace`, `project`, `source_branch`, `target_branch`, `title`, optional `description`/`draft`/`assignee_ids`/`reviewer_ids`/`labels`/`milestone_id`/`remove_source_branch`/`squash` |
| `update_merge_request` | `namespace`, `project`, `mr_iid`, optional `title`/`description`/`target_branch`/`state_event=reopen`/`assignee_ids`/`reviewer_ids`/`labels`/`milestone_id`/`remove_source_branch`/`squash` |
| `close_merge_request` | `namespace`, `project`, `mr_iid` |
| `create_issue` | `namespace`, `project`, `title`, optional `description`/`assignee_ids`/`labels`/`milestone_id`/`due_date` |
| `update_issue` | `namespace`, `project`, `iid`, optional `title`/`description`/`assignee_ids`/`labels`/`milestone_id`/`due_date`/`state_event=reopen` |
| `close_issue` | `namespace`, `project`, `iid` |
| `add_note` | `namespace`, `project`, `noteable_type`, `noteable_iid`, `body`, optional `position` (MR diff comments only) |
| `update_note` | `namespace`, `project`, `noteable_type`, `noteable_iid`, `note_id`, `body` |
| `delete_note` | `namespace`, `project`, `noteable_type`, `noteable_iid`, `note_id` |
| `create_release` | `namespace`, `project`, `tag_name`, `name`, optional `description`/`ref`/`assets` |
| `update_release` | `namespace`, `project`, `tag_name`, optional `name`/`description`/`milestones` |
| `delete_release` | `namespace`, `project`, `tag_name` |
| `delete_release_link` | `namespace`, `project`, `tag_name`, `link_id` |
| `retry_pipeline` | `namespace`, `project`, `pipeline_id` |
| `retry_failed_jobs` | `namespace`, `project`, `pipeline_id` |
| `cancel_pipeline` | `namespace`, `project`, `pipeline_id` |
| `trigger_pipeline` | `namespace`, `project`, `token`, `ref`, optional `variables` |
| `play_job` | `namespace`, `project`, `job_id`, optional `variables` |

## Admin actions (denied by default — operator must opt in)

| Action | Required params |
|---|---|
| `merge_merge_request` | `namespace`, `project`, `mr_iid`, optional `merge_commit_message`/`squash_commit_message`/`should_remove_source_branch`/`merge_when_pipeline_succeeds`/`sha`/`squash` |

To enable `merge_merge_request`, set `policy.admin: escalate` in
`~/.gitlab-agent/config.yaml` (or the repo-level overlay).

## Credentials

Set `GITLAB_TOKEN` to a PAT with:
- `api` scope — required for all read + write + admin actions

Optional:
- `GITLAB_HOST` — self-hosted GitLab base URL (default: `https://gitlab.com`)
- `GITLAB_NAMESPACE` — default group/user namespace; omit when passing `namespace` explicitly

## Config

`~/.gitlab-agent/config.yaml` (user-level) merges with
`<cwd>/.gitlab-agent/config.yaml` (repo overlay). Beyond the toolkit's
standard `policy` and `approval_mode` keys, the connector reads:

```yaml
policy:
  read: success
  write: escalate
  admin: escalate              # enables merge_merge_request
  aspects:
    delete: escalate            # cannot be set to success — floored
approval_mode: confirm_once
gitlab:
  require_draft_mr: true       # forces every create_merge_request to draft=true
  host: https://gitlab.example.com   # self-hosted GitLab base URL
```

Runtime override: `GITLAB_REQUIRE_DRAFT_MR=1` forces drafts even when
the YAML says false; `GITLAB_REQUIRE_DRAFT_MR=0` forces non-drafts.
Invalid values throw at startup.

## Safety

Every write call goes through the toolkit's policy gate. With no
operator config, writes escalate (asking once), deletes escalate with a
`delete` aspect for audit, and admin actions are denied until the
operator explicitly opts in via YAML. The `delete` aspect is floored —
operator config cannot downgrade it to `success`.
