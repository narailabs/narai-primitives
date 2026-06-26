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

## Shipped example presets

The `jira` and `gitlab` connectors ship a `gates.json` as a starting point.
These presets are intentionally conservative — they prefer `ask` over `deny` —
because each connector performs writes through its own CLI or raw HTTP client
rather than a single canonical path. Treat them as examples to adapt, not as a
complete policy.

- **jira** (`plugins/jira-connector/gates.json`): asks before a state-changing
  HTTP request (an `-X POST|PUT|DELETE|PATCH` or `--request ...` via `curl` /
  `http` / `https` / `wget`) to a host containing `atlassian.net` or `jira`. A
  plain `GET` to the same host does not match.
- **gitlab** (`plugins/gitlab-connector/gates.json`): denies a merge-request
  create that lacks a draft marker (`glab mr create` without `--draft`/`-draft`,
  or a `curl` `POST` to `merge_requests` with no draft indicator) and asks on
  other state-changing HTTP to a host containing `gitlab`. A `GET` does not
  match.

## Customizing

To adapt a preset, copy it to `~/.connectors/connectors/<slug>/gates.json` and
edit:

- **Host**: replace the host token (e.g. `atlassian\\.net`, `gitlab`) with the
  domain your team uses.
- **Verbs**: add or remove HTTP verbs in the verb group, or tighten the rule to
  specific API paths.
- **Decision**: change `ask` to `deny` once you are confident a pattern should
  always be blocked, or to `allow` to silence a noisy rule.

### Known limitations

- The example HTTP rules key on an explicit `-X` / `--request` verb flag, so a
  client that takes the verb as a positional argument (for example, HTTPie's
  `https POST <url>` shorthand) is not matched by the shipped pattern. Extend
  the pattern if your team uses that form.
- The gitlab draft-absence check uses a negative lookahead scoped to a single
  command segment; it cannot reason across piped or chained segments.
- Because patterns are line-oriented regexes over the raw command string, they
  are best-effort heuristics, not a sandbox. Keep server-side controls in place.
