# Security policy

## What this plugin is

A `PreToolUse` hook that classifies `git` invocations made through Claude
Code's `Bash` tool and emits permission decisions (`allow` / `ask` /
`deny`). It runs inside the user's Claude Code session, on the user's
machine, with the user's privileges.

## What this plugin is NOT

**This plugin is not a security boundary.** It is a *speed bump* against
accidental destructive commands — the same role as a shell alias that
re-prompts on `rm -rf`. Treat it as a usability guardrail, not access
control.

A user (or anyone with write access to the user's environment) can defeat
the plugin trivially by:

- Running git outside Claude Code (a regular terminal, an IDE git panel, a
  CI runner, etc.). The hook only fires for commands routed through
  Claude Code's `Bash` tool.
- Disabling the plugin in Claude Code (`/plugin disable git-connector`) or
  removing the marketplace entry.
- Toggling permission mode to `bypassPermissions` — that mode skips the
  hook entirely.
- Accepting the `ask` prompt at the moment it appears.
- Setting `NARAI_GATE_DISABLE` to silence rules by name, or dropping
  a custom `~/.connectors/connectors/<slug>/gates.json` (the dispatcher
  trusts both unconditionally — see "Config file trust" below).
- Writing a bash command that evades pattern matching (see
  "Pattern-matching limits" below).

If your threat model includes a malicious or curious user who has shell
access on the same machine, this plugin does not help. Use repository
permissions, branch protection rules on the remote, and CI policy
checks instead — those run on infrastructure outside the user's control.

## What it does help with

- Stopping a model (or a sleepy human reviewing model output) from
  running `git push origin main` without confirmation.
- Catching `git reset --hard` and `git clean -fdx` before they execute.
- Surfacing a confirmation prompt with operator-supplied reason text so
  the user understands the consequences before approving.
- Reducing blast radius from agentic flows that compose multiple git
  commands in one Bash invocation — each compound segment is classified
  independently.

## Pattern-matching limits

The classifier in [`gates.json`](gates.json) works on the literal command string.
Several constructs can evade matching:

- **Quoted operators**: a literal `&&` inside single quotes splits the
  command for the segmenter. Over-splitting is the intended bias —
  every sub-segment still gets classified — but the segments themselves
  are not properly tokenised, so a quoted git argument can defeat
  pattern anchors. Example: `eval 'git push --force'` is classified by
  matching on `git push --force` (the quoted body), but `eval "$(echo
  git push)"` is not.
- **Indirection**: `bash -c "$cmd"` where `$cmd` expands to a git
  command. The hook sees the outer `bash -c "..."`, not the inner
  expansion, and will not match.
- **Aliases / functions**: a shell alias `gpf=git push --force` invoked
  as `gpf` does not match because the hook never sees the resolved
  command.
- **Custom branch names**: the `push_main` rule matches any
  `\bmain\b` or `\bmaster\b` token in the push args. A literal branch
  named `feature/main` will trip the rule. Disable via
  `NARAI_GATE_DISABLE=push_main` if your repo uses such names.

If you need defense-in-depth against these, add **server-side branch
protection** on the remote and require status checks before merge. The
plugin handles the local-side speed bump; the server enforces the rule.

## Config file trust

The dispatcher reads any `~/.connectors/connectors/<slug>/gates.json`
files if present (and the same under the current working directory).
Those files are trusted unconditionally — if an attacker can write to
that path, they can:

- Add a custom rule with `decision: "allow"` to short-circuit a default
  `ask` (note: `allow` cannot beat a `deny` due to precedence, but it
  can beat an `ask`).
- Layer a rule with the same regex as a default but a softer decision,
  effectively muffling the prompt with a less alarming reason.

Mitigations:

- Keep the parent directory (`~/.connectors/`) writable only by the
  owner (`chmod 700`).
- Treat write access to `~/.connectors/` as equivalent to shell access.
  If your threat model includes someone who can modify files in `$HOME`
  but not run git directly, the gate surface is one of many they could
  weaponise.

## Hook contract assumptions

The plugin assumes Claude Code honours the documented hook contract
(reads `tool_input.command` for `Bash` calls, respects
`hookSpecificOutput.permissionDecision` of `"deny"`, etc.). If a future
version of Claude Code changes the contract, the plugin may silently
stop gating. Track the [hooks
documentation](https://code.claude.com/docs/en/hooks.md) and verify
behavior after Claude Code upgrades.

The hook script itself is the shared `plugin-hooks/dispatcher.mjs` from
`narai-primitives`. It reads only the stdin payload + on-disk gate
manifests (`CLAUDE_PLUGIN_ROOT/gates.json`, `~/.connectors/connectors/*/gates.json`, and the same under cwd). It does not invoke `git`, write
files in the gate path, or make network requests.

## Reporting a vulnerability

If you find a way for a `deny`-classified command to slip through the
hook in default configuration (no env vars, no config file), please
open an issue at
<https://github.com/narailabs/narai-primitives/issues> with:

- The command string the hook should have caught
- The actual decision the hook produced (or null if none)
- The Claude Code version and operating system

Behaviour we consider intentional, not vulnerabilities:

- Bypass via permission-mode toggling (`bypassPermissions`).
- Bypass via env var or config file overrides.
- Bypass via shell indirection (`bash -c`, `eval`, aliases) — see
  "Pattern-matching limits".
- False positives where a safe command matches a default rule (those
  are usability bugs; please file them, but they are not security
  issues).

## Supported versions

Only the latest published version of `git-connector` receives security
fixes. Older versions are not maintained. Pin to a specific version
only if you have a tested compatibility constraint.

## License

MIT — see `LICENSE` at the repo root.
