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
