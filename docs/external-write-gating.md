# External-write gating for connectors

The external-API connectors (`jira`, `gitlab`, `github`, `linear`, `notion`)
route their `Bash`/`Write`/`Edit` activity through the shared dispatcher
(`plugin-hooks/dispatcher.mjs`). The dispatcher can gate individual commands
before they run, based on rules declared in a `gates.json` manifest.

This document explains where gate manifests are discovered, the shape of a gate
rule, and how to customize the conservative example presets that ship with the
`jira` and `gitlab` connectors.

## Where gate manifests come from

The dispatcher loads gate rules from, in order:

1. A plugin-shipped `gates.json` at `${CLAUDE_PLUGIN_ROOT}/gates.json`.
2. A user/cwd manifest discovered at
   `~/.connectors/connectors/<slug>/gates.json` (and the repo-local
   `<cwd>/.connectors/connectors/<slug>/gates.json` overlay), where `<slug>`
   is the connector slug (e.g. `jira`, `gitlab`).

Operator-supplied manifests are the intended place to encode your own policy.
You do not have to fork a connector to gate its writes: drop a `gates.json`
under `~/.connectors/connectors/<slug>/` and the dispatcher will discover it.

## Rule shape

A manifest is `{ "version": 1, "name": "<slug>", "rules": [ ... ] }`. Each rule
is:

```json
{
  "name": "unique_rule_name",
  "decision": "deny",
  "reason": "Shown to the operator when the rule fires.",
  "pattern": "^some\\s+regex",
  "applies_to": ["Bash"]
}
```

- `decision` is one of `deny`, `ask`, or `allow`. When several rules match the
  same command, the strictest decision wins (`deny` > `ask` > `allow`).
- `pattern` is compiled with `new RegExp(pattern)` with **no flags**. There is
  no inline case-insensitivity, so write case explicitly using character
  classes (e.g. `[Pp][Oo][Ss][Tt]`) when you need it.
- For `Bash`, the command is split into segments on `&&`, `||`, `;`, and `|`,
  and each segment is matched independently, so a rule fires if any segment
  matches.
- `applies_to` defaults to `["Bash"]`.

### The `external_write` rule type (recommended for HTTP write-gating)

Gating external writes by hand-writing a host regex is error-prone: a bare
host substring such as `gitlab` over-matches attacker subdomains
(`gitlab.evil.com`), paths (`/gitlab-mirror`), and label prefixes
(`my-gitlab.evil.com`). Prefer the declarative `external_write` type, which
parses the request and matches the **registrable host** at a real URL host
boundary:

```json
{
  "name": "jira_external_write",
  "type": "external_write",
  "decision": "ask",
  "reason": "Shown to the operator when the rule fires.",
  "methods": ["POST", "PUT", "DELETE", "PATCH"],
  "allowed_hosts": ["atlassian.net"],
  "write_cli": ["glab mr create"],
  "applies_to": ["Bash"]
}
```

- `methods` — the HTTP verbs that count as state-changing. The rule fires only
  when one of these verbs is present, via `curl -X`/`--request`, `wget
  --method`, or HTTPie's positional `http[s] VERB <url>` form. Verbs are matched
  case-insensitively (`-X post` is caught), but curl's `-X` flag itself is
  matched case-sensitively so it is not confused with `-x` (the proxy flag).
- `allowed_hosts` — hostnames to gate. A host matches when it equals an entry or
  is a dotted subdomain of one (`acme.atlassian.net` matches `atlassian.net`).
  The host must appear as the real URL host — immediately after `scheme://` and
  any `user:pass@` — so it cannot be spoofed via a path, query string, userinfo,
  a suffix (`atlassian.net.evil.com`), or a label prefix
  (`evil-atlassian.net`). A `GET` (or any verb not in `methods`) does not fire.
- `write_cli` — optional list of write subcommands (e.g. `glab mr create`) that
  should fire the rule regardless of host.
- `pattern` is omitted for `external_write` rules; `decision`, `reason`,
  `applies_to`, name-based disabling, and strictest-wins all behave as for
  `pattern` rules.

## Shipped example presets

The `jira` and `gitlab` connectors ship a `gates.json` as a starting point.
These presets are intentionally conservative — they prefer `ask` over `deny` —
because each connector performs writes through its own CLI or raw HTTP client
rather than a single canonical path. Treat them as examples to adapt, not as a
complete policy.

- **jira** (`plugins/jira-connector/gates.json`): an `external_write` rule that
  asks before a state-changing request (`POST`/`PUT`/`DELETE`/`PATCH`) to
  `atlassian.net` or any of its subdomains. A plain `GET`, or a request to a
  different host, does not match.
- **gitlab** (`plugins/gitlab-connector/gates.json`): denies a merge-request
  create that lacks a draft marker (`glab mr create` without `--draft`/`-draft`,
  or a `curl` `POST` to `merge_requests` with no draft indicator), and an
  `external_write` rule that asks on other state-changing requests to
  `gitlab.com`. A `GET` does not match.

## Customizing

To adapt a preset, copy it to `~/.connectors/connectors/<slug>/gates.json` and
edit:

- **Host**: add your team's domain(s) to `allowed_hosts` (for a self-hosted
  GitLab, set `allowed_hosts` to your GitLab domain). No regex required.
- **Verbs**: add or remove HTTP verbs in `methods`.
- **Decision**: change `ask` to `deny` once you are confident a request should
  always be blocked, or to `allow` to silence a noisy rule.

### Known limitations

- Gating operates on the literal command string. A target supplied indirectly
  (a shell variable such as `curl -X POST "$URL"`, or a value read from a file)
  is not resolved, so the host cannot be matched. Keep server-side controls in
  place — these rules are best-effort heuristics, not a sandbox.
- An allowlisted host used only as a **proxy** (e.g. `curl -X POST -x
  https://atlassian.net:8080 https://other.example/...`) still fires the rule,
  because the allowlisted host does appear in the request. This is a
  conservative over-`ask`, never an under-deny.
- The gitlab draft-absence check (a `pattern` rule) uses a negative lookahead
  scoped to a single command segment; it cannot reason across piped or chained
  segments.
