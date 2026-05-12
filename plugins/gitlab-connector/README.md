# gitlab-connector plugin

Read and write GitLab data — project info, code search, issues,
merge requests, notes, releases, and CI pipelines — through the
narai-primitives connector toolkit's policy gate.

## Credentials

Set `GITLAB_TOKEN` to a PAT with `api` scope.

| Scope | Why |
|---|---|
| `api` | Full read + write access to projects, issues, MRs, notes, releases, and pipelines |

Tokens without `api` scope will see `AUTH_ERROR` with a scope hint
when invoking any endpoint.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `GITLAB_HOST` | `https://gitlab.com` | Self-hosted GitLab base URL |
| `GITLAB_NAMESPACE` | (none) | Default group/user namespace; omit when passing `namespace` explicitly per action |

## Config

Place YAML at `~/.gitlab-agent/config.yaml` (user-level) or
`<cwd>/.gitlab-agent/config.yaml` (repo overlay). Repo overlay wins on
collisions.

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
  host: https://gitlab.example.com   # self-hosted GitLab base URL (overrides GITLAB_HOST)
```

Runtime override: `GITLAB_REQUIRE_DRAFT_MR=1` forces drafts even when
the YAML says false; `GITLAB_REQUIRE_DRAFT_MR=0` forces non-drafts.
Invalid values throw at startup.

## Action surface

33 actions across reads (14), writes (18), and admin (1). See
`skills/gitlab-connector/SKILL.md` for the full table.

## Self-hosted GitLab

Self-hosted GitLab >= 12.x (Bearer-auth PAT support) is supported. Set
`GITLAB_HOST` or `gitlab.host` in config to your instance base URL,
e.g. `https://gitlab.example.com`. The connector appends `/api/v4/` to
all requests.

## License

See repo root.
