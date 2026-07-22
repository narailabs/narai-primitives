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
- `pattern` is compiled with `new RegExp(pattern, flags)`. By default no flags
  are applied (a rule with neither field below compiles exactly as before, so
  character classes like `[Pp][Oo][Ss][Tt]` keep working). For
  case-insensitivity, set `ignore_case: true` (folds in the `i` flag) instead of
  hand-writing character classes.
- `flags` (optional) is a string of regex flags drawn from `imsu` only (`i`
  case-insensitive, `s` dotall, `m` multiline, `u` unicode). The `g` and `y`
  flags are rejected: the compiled regex is reused across command segments, and
  a global/sticky flag carries `lastIndex` between matches and would
  intermittently miss. Under `fail_closed`, an unknown flag is a hard deny;
  under `fail_open` the rule is skipped.
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

## Ask memoization (`memo`): approve once per workload

A repeated `ask` for the same intent — pushing the same feature branch six
times during one working session — trains operators to click through prompts.
A rule may opt in to **ask memoization** so an approval is remembered for the
rest of that workload:

```json
{
  "name": "push",
  "decision": "ask",
  "reason": "Pushing publishes commits. Confirm before proceeding.",
  "pattern": "^git\\s+push(\\s|$)",
  "memo": { "scope": "repo_branch", "idle_minutes": 30, "max_hours": 8 }
}
```

Memoization is **inert by default**: it activates only when the operator sets
`NARAI_MEMO_PATH` to a writable state directory (mirroring how
`NARAI_AUDIT_PATH` activates auditing), and `NARAI_MEMO_DISABLE=1` is the kill
switch. With no grants on disk, dispatcher *output* is byte-identical to the
non-memoized behavior; the only side effect is a pending record written under
`NARAI_MEMO_PATH` on each memoized ask (pruned opportunistically). `deny`
rules never consult the memo store, and a rule without a `memo` field is
never memoized.

How a grant comes to exist — the first ask always happens:

1. The winning `ask` from a memo-carrying rule records a *pending* entry and
   leaves the ask unchanged. The operator sees the prompt.
2. The `post-tool-use` event fires only if the tool actually ran — i.e. the
   operator approved the ask (a hook `ask` cannot be silenced by client-side
   allowlists). The pending entry is promoted to a *grant*. Execution under
   `bypassPermissions`-style modes does not count: it cannot prove a human
   approved. Note that the tool's *exit status* is deliberately not consulted:
   what is memoized is the operator's approval of the intent, so an approved
   push that then fails (network, rejected ref) still grants — the retry is
   the same approved intent.
3. The next `ask` from the same rule, same scope, and same session replays as
   an `allow`, announced to the operator via `systemMessage` with a revocation
   phrase. Every replay, grant, and invalidation is written to the
   `NARAI_AUDIT_PATH` audit trail (`guardrail_memo_replay`,
   `guardrail_memo_granted`, `guardrail_memo_invalidated`).

What makes a grant live — the workload model:

- **Scope identity is primary.** `repo_branch` keys the grant to the git repo
  toplevel + remote + branch, re-resolved from the *current* command and
  repository state on every replay — so different branches are independent
  grants by construction, and a branch switched behind the guard's back can
  never fire a stale grant. `exact_command` keys to the literal command
  string. Scope resolution fails closed: a non-git directory, detached HEAD,
  non-literal `cd` target, delete/force/mapped refspec, a push flag outside
  the scope-neutral whitelist (`-u`, `--set-upstream`, quiet/verbose/progress
  reporting — everything else, `--tags`/`--all`/`--delete`/`--force*`/
  `--repo`/`-o`/unknown, is a different intent), a command that moves HEAD
  before pushing (`git checkout`/`git switch` in any segment), or a rule that
  fired on a substring false-positive (`echo git push`) simply keeps asking.
- **Freshness is a sliding idle window**, not an absolute timer: the grant
  expires `idle_minutes` (default 30) after its *last* replay, and every
  replay refreshes the clock. An actively used workload stays approved; an
  abandoned one disarms itself.
- **Deterministic invalidation.** A `git checkout`/`git switch` observed on
  `post-tool-use` drops the repo's grants for branches other than the
  now-current one. Grants are session-keyed, so a new session always re-asks.
  `max_hours` (default 8) is an outer backstop from grant time.

Revocation and inspection:

```sh
NARAI_MEMO_PATH=... node plugin-hooks/memo.mjs clear    # drop all grants (audited)
NARAI_MEMO_PATH=... node plugin-hooks/memo.mjs status   # list grants as JSONL
NARAI_MEMO_PATH=... node plugin-hooks/memo.mjs prune    # sweep expired state
```

Threat model: a grant file is a **standing promptless approval**, so the
store is security-relevant state. It is written with owner-only permissions
(0700 directories, 0600 files), grants are keyed to the live `session_id`
(not normally present in a model's context), and every replay is both audited
and announced — so a fabricated or stolen grant cannot fire silently. But the
store lives on the same filesystem the gated agent can write to: an agent
with unrestricted shell access could in principle forge a grant for its own
session. That is no worse than the same agent editing the gate manifest or
the hook itself — filesystem integrity is the trust boundary, as it always
was — but operators auditing an incident should treat `NARAI_MEMO_PATH`
contents as part of the record.

Pick `memo` rules deliberately. A repeated push to the same feature branch is
the same intent; creating a merge request, force-pushing, deleting a remote
branch, or reading a credential file is a distinct decision every time — leave
those un-memoized. Also prefer leaving `repo_branch` rules un-memoized in
repositories configured with `push.default=matching`, where a bare `git push`
pushes all matching branches rather than the one the grant names.

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

Gating operates on the **literal command string**, so anything that hides the
host or verb behind a layer of indirection cannot be matched. These rules are
best-effort heuristics, not a sandbox — keep server-side controls in place. In
particular, the following evade matching by design:

- **Indirection**: the target supplied through a shell variable
  (`URL=https://x.atlassian.net; curl -d a "$URL"`), a command substitution
  (`curl -X POST "https://$(echo atlassian.net)/x"`), or a value read from a
  file. The literal command never contains the resolved host.
- **Obfuscation**: a request assembled from an encoded payload
  (`echo <base64> | base64 -d | sh`) or built up programmatically.
- **Exotic wrappers**: a client invoked through `xargs`, `command`, or a
  non-standard alias the segmenter does not strip.
- **Bundled short-flag clusters**: a curl data/upload flag buried inside a
  short-flag cluster (`curl -sd ...` instead of `curl -s -d ...`). These cannot
  be matched without false-positives on attached flag arguments (for example
  `curl -odraft.json` is a download, not a POST), so the common separate-flag
  forms are matched and the bundled form is treated as obfuscation.

What the `external_write` type *does* handle robustly: explicit verbs
(`curl -X`/`--request`, `wget --method`), method-implying flags
(`curl -d`/`--data*`/`-F`/`--form`/`-T`/`--upload-file`/`--json`, `wget
--post-data`/`--post-file`), HTTPie positional and implicit-POST forms,
scheme-less and single-slash URLs, and host-spoofing via path, query, userinfo,
subdomain suffix, label prefix, or trailing FQDN dot.

Other notes:

- An allowlisted host used only as a **proxy** (e.g. `curl -X POST -x
  https://atlassian.net:8080 https://other.example/...`) still fires the rule,
  because the allowlisted host does appear in the request. This is a
  conservative over-`ask`, never an under-deny.
- The gitlab draft-absence check (a `pattern` rule) uses a negative lookahead
  scoped to a single command segment; it cannot reason across piped or chained
  segments.
