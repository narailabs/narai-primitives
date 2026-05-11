# git-plugin

Claude Code plugin that gates risky `git` commands at the `PreToolUse` hook.
No agents, no actions — pure permission gating.

## Default rules

| Rule | Decision | When it fires |
|---|---|---|
| `push_main` | **deny** | `git push` whose refspec targets `main` or `master` |
| `force_push` | **ask** | `git push --force` / `-f` / `--force-with-lease` |
| `delete_branch_remote` | **ask** | `git push --delete`, `git push -d`, or `git push <remote> :branch` |
| `push` | **ask** | Any other `git push` |
| `delete_branch_local` | **ask** | `git branch -D`, `git branch --delete --force` |
| `reset_hard` | **ask** | `git reset --hard` |
| `checkout_discard` | **ask** | `git checkout <pathspec>` / `git restore --worktree` / `git checkout .` |
| `clean_force` | **ask** | `git clean -f…` (any `-f` variant, including `-fdx`) |

Decision precedence: `deny` > `ask` > `allow`. If multiple rules match across
a compound command (`a && b`), the strictest wins.

If no rule matches, the hook emits no decision and Claude Code's default
permission flow continues.

## Disabling rules

Set `NARAI_GATE_DISABLE` to a comma-separated list of rule names:

```sh
export NARAI_GATE_DISABLE=push,push_main
```

…disables both the plain-`push` ask and the protected-branch deny.

## Adding rules

Drop extra rules at `~/.connectors/connectors/<slug>/gates.json` — the
shared dispatcher scans this path and layers the rules on top of the
defaults shipped with this plugin:

```json
{
  "rules": [
    {
      "name": "deny_release",
      "decision": "deny",
      "reason": "Pushing to release branches needs SRE approval.",
      "pattern": "^git\\s+push\\s+\\S+\\s+release\\b"
    },
    {
      "name": "ask_worktree_remove",
      "decision": "ask",
      "reason": "Removing a worktree is irreversible.",
      "pattern": "^git\\s+worktree\\s+remove\\b"
    }
  ]
}
```

`pattern` is a JavaScript regex source applied to each command segment
(after splitting on `&&`, `||`, `;`, `|`). `decision` must be one of
`allow`, `ask`, `deny`. `reason` is shown to the user in the prompt.

Custom rules are evaluated alongside the defaults; the strictest match
across all rules wins.

## How it works

`PreToolUse` hooks fire before any Bash invocation. The plugin wires
this event to the shared `plugin-hooks/dispatcher.mjs` from
`narai-primitives`, which loads this plugin's `gates.json` (the default
rules), applies them to `tool_input.command`, and writes a JSON decision
to stdout per the [hook contract](https://code.claude.com/docs/en/hooks.md).

Compound commands (`cd repo && git push origin main`) split on `&&`, `||`,
`;`, `|` and each segment is classified independently — the strictest
decision wins. Leading env-var assignments (`FOO=bar git push`) and
common prefixes (`sudo`, `nice`, `time`) are stripped before matching.

## Limitations

- The command splitter doesn't track quoted strings — a literal `&&`
  inside single quotes will split the segment. Over-splitting is the
  intended bias for a safety gate.
- `push_main` matches any `main` or `master` token in the push args.
  A branch literally named `feature/main` would trip this. Disable
  `push_main` via `NARAI_GATE_DISABLE=push_main` if your repo has such names.
- The hook runs on every Bash call. Performance is dominated by Node
  startup (~30ms cold). The hook itself is O(rules × segments) regex
  matching — negligible.

## License

MIT
