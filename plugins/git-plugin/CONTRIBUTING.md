# Contributing to `git-plugin`

This plugin is small. Contributions usually land in one of three places:

1. **A new default rule** — see [Adding a default rule](#adding-a-default-rule).
2. **A bug in an existing rule** — false positive, missed pattern, edge case in the splitter. See [Fixing a rule](#fixing-a-rule).
3. **Hook contract drift** — Claude Code changes the PreToolUse payload shape or output expectations. See [Hook contract](#hook-contract).

For changes elsewhere in the repo (other connectors, toolkit, hub), follow the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Plugin-specific guidance below.

## Local dev loop

```sh
# from the repo root
npm install
npx vitest run tests/plugins/git-plugin/
```

The hook runs as a standalone Node ESM script. To smoke-test it end-to-end against a fake stdin payload:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"hook_event_name":"PreToolUse","cwd":"/tmp"}' \
  | node plugins/git-plugin/hooks/git_gate.mjs
```

Should print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}` to stdout. A non-git or unmatched command produces no output (the hook's signal that it has no opinion).

## Adding a default rule

Default rules live in [`hooks/rules.mjs`](hooks/rules.mjs) under `DEFAULT_RULES`. Each rule is:

```js
{
  name: "rule_name",                                    // stable identifier
  decision: "deny" | "ask" | "allow",
  reason: "Sentence shown to the user in the prompt.",
  match: (segment) => boolean,                          // pure function
}
```

Rules are evaluated in order against each segment of a compound command (split on `&&`, `||`, `;`, `|`). The strictest matching decision wins (`deny` > `ask` > `allow`).

### Steps

1. Add the rule object to `DEFAULT_RULES` in `hooks/rules.mjs`. Keep `deny` rules at the top, `ask` rules below, ordered roughly by specificity — more specific rules first so their reason text wins ties.

2. Add a `describe` block in [`tests/plugins/git-plugin/rules.test.ts`](../../tests/plugins/git-plugin/rules.test.ts) covering:
   - **Positive cases**: each command form your rule is meant to catch (use `it.each`).
   - **Negative cases**: adjacent-but-safe commands that must not fire. This is where most rule-design bugs hide. If you skip negative cases, your rule will produce false positives in the wild.
   - **Precedence interaction**: if your rule's decision can be overruled by an existing `deny` rule, add a test that verifies the strictest-wins resolution.

3. Document the rule in [`README.md`](README.md) under "Default rules". Match the existing table style.

4. If the rule has known false-positive scenarios, document them under "Limitations" in `README.md` and mention that operators can disable via `GIT_GATE_DISABLE=<rule_name>`.

### Style guidance

- **Keep the regex anchored.** All default rules anchor on `^git\s+<verb>` so a string like `echo "git push"` doesn't trigger them. The splitter strips env-prefixes (`FOO=bar`) and `sudo`/`nice`/`time` before rules see the segment.
- **Avoid lookbehinds and back-references** unless you have a clear reason. They make the rule harder to read and slower; this code runs on every Bash call.
- **Bias toward over-flagging.** A safe command flagged for confirmation is annoying; a dangerous command that slipped through is the failure mode this plugin exists to prevent.
- **Don't widen `match` to do I/O.** Rules are pure. If you need git state (current branch, remote URL), the hook entry point can add it to the segment context, but no rule should shell out or read files.

## Fixing a rule

If you're chasing a false positive or missed pattern:

1. Reproduce in a test first — add the failing case to `rules.test.ts` so the regression is captured. The fix should make the new case pass without breaking the existing 70.
2. Prefer narrowing the regex over deleting the rule. If the rule is genuinely unsalvageable, delete it cleanly (rule object, tests, README row, any `GIT_GATE_DISABLE` guidance) in a single commit.
3. If the false positive is rare and the rule is otherwise valuable, document it under "Limitations" rather than weakening the rule.

## Hook contract

The plugin reads stdin and writes stdout per the [Claude Code hook
contract](https://code.claude.com/docs/en/hooks.md). The current shape
the entry point relies on:

- **Input**: `{tool_name: "Bash", tool_input: {command: string}, ...}`
- **Output**: `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason: string}}`
- **Exit code**: `0` for any decision (the JSON is the signal). Non-zero stays for genuine script errors.

If Claude Code changes the contract:

1. Update the JSDoc at the top of `hooks/git_gate.mjs` and the README's "How it works" section.
2. Bump `version` in `.claude-plugin/plugin.json` and `package.json`.
3. Test against the new Claude Code version with the smoke-test command above before merging.

The hook entry point is the only file with side effects (stdin/stdout/fs/env). `rules.mjs` is pure and should stay that way — the test suite depends on it.

## Code conventions

- **No runtime npm deps.** The hook ships as raw `.mjs` files and runs under whatever Node Claude Code launches it with (≥ 20.10 per the user's environment). If you need YAML or another parser, justify it in the PR — adding deps couples the plugin's runtime to Claude Code session startup, and the current dependency-free design is deliberate.
- **No bin/ shim and no SessionStart npm install.** Unlike the connector plugins, this plugin doesn't need them. Don't add infrastructure that isn't used.
- **2-space indent**, ESM-only (`.mjs`), no TypeScript in plugin source. Tests are TS because Vitest's include glob is `**/*.test.ts`; that's fine — the test imports the `.mjs` file directly.
- **No emojis** in source or docs (matches repo style).
- **Match existing patterns** in `rules.mjs` and `git_gate.mjs`. Don't reformat adjacent code.

## Commit + PR hygiene

- Commit messages follow conventional-commits style: `feat(git-plugin): ...`, `fix(git-plugin): ...`, `docs(git-plugin): ...`, `test(git-plugin): ...`.
- One logical change per commit. If a rule fix needs a test update and a README update, those go in the same commit.
- Run `npx vitest run tests/plugins/git-plugin/` before pushing. The full repo suite (`npx vitest run`) should also pass — the plugin shouldn't affect anything outside its directory, but verify before claiming "no regressions".
- Open the PR against `main`. The plugin lives outside the connector PR stack and ships independently.

## Out of scope

This plugin deliberately does NOT:

- **Block the command.** The strictest decision is `deny`, which makes Claude refuse and surfaces the reason — but the user can still run the command themselves outside the session. See [SECURITY.md](SECURITY.md) for the full list of bypass paths and why they are intentional.
- **Track git state.** No `git rev-parse`, no remote URL inspection, no branch detection. Rules operate on the literal command string. If you want behaviour gated on current branch (e.g., "deny rebase only when on main"), that's a real proposal — open an issue first to discuss whether the added I/O cost on every Bash call is worth it.
- **Replace branch protection.** Server-side branch protection rules on the remote are the actual enforcement layer. This plugin reduces blast radius from agentic flows; it does not gate the remote.

## License

MIT — see `LICENSE` at the repo root.
