# Contributing to `git-connector`

This plugin is small. Contributions usually land in one of three places:

1. **A new default rule** — see [Adding a default rule](#adding-a-default-rule).
2. **A bug in an existing rule** — false positive, missed pattern, edge case in the splitter. See [Fixing a rule](#fixing-a-rule).
3. **Hook contract drift** — Claude Code changes the PreToolUse payload shape or output expectations. See [Hook contract](#hook-contract).

For changes elsewhere in the repo (other connectors, toolkit, hub), follow the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Plugin-specific guidance below.

## Local dev loop

```sh
# from the repo root
npm install
npx vitest run tests/plugins/git-connector/
```

The plugin wires its `PreToolUse` hook to the shared `plugin-hooks/dispatcher.mjs` in `narai-primitives`. To smoke-test the gate end-to-end against a fake stdin payload, point `CLAUDE_PLUGIN_ROOT` at the plugin and run the dispatcher directly:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"hook_event_name":"PreToolUse"}' \
  | CLAUDE_PLUGIN_ROOT=plugins/git-connector \
    CLAUDE_PLUGIN_DATA=/tmp/git-connector-data \
    node plugin-hooks/dispatcher.mjs pre-tool-use
```

Should print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}` to stdout. A non-git or unmatched command produces no output (the dispatcher's signal that it has no opinion).

## Adding a default rule

Default rules live in [`gates.json`](gates.json). Each rule has the shape:

```json
{
  "name": "rule_name",
  "decision": "deny",
  "reason": "Sentence shown to the user in the prompt.",
  "pattern": "^git\\s+<verb>\\b..."
}
```

`pattern` is a JavaScript regex source. The dispatcher splits each compound command on `&&`, `||`, `;`, `|`, strips leading env-prefixes and `sudo`/`nice`/`time`, then tests each segment against every rule. The strictest matching decision wins (`deny` > `ask` > `allow`).

### Steps

1. Add the rule object to the `rules` array in [`gates.json`](gates.json). Keep `deny` rules at the top, `ask` rules below, ordered roughly by specificity — more specific rules first so their reason text wins ties.

2. Add a `describe` block in [`tests/plugins/git-connector/gates.test.ts`](../../tests/plugins/git-connector/gates.test.ts) covering:
   - **Positive cases**: each command form your rule is meant to catch (use `it.each`).
   - **Negative cases**: adjacent-but-safe commands that must not fire. This is where most rule-design bugs hide. If you skip negative cases, your rule will produce false positives in the wild.
   - **Precedence interaction**: if your rule's decision can be overruled by an existing `deny` rule, add a test that verifies the strictest-wins resolution.

3. Add an end-to-end case in [`tests/plugins/git-connector/smoke.test.ts`](../../tests/plugins/git-connector/smoke.test.ts) if the rule covers a category not already exercised.

4. Document the rule in [`README.md`](README.md) under "Default rules". Match the existing table style.

5. If the rule has known false-positive scenarios, document them under "Limitations" in `README.md` and mention that operators can disable via `NARAI_GATE_DISABLE=<rule_name>`.

### Style guidance

- **Keep the regex anchored.** All default rules anchor on `^git\s+<verb>` so a string like `echo "git push"` doesn't trigger them. The dispatcher strips env-prefixes (`FOO=bar`) and `sudo`/`nice`/`time` before rules see the segment.
- **Avoid lookbehinds and back-references** unless you have a clear reason. They make the rule harder to read and slower; this code runs on every Bash call.
- **Bias toward over-flagging.** A safe command flagged for confirmation is annoying; a dangerous command that slipped through is the failure mode this plugin exists to prevent.
- **Don't push behaviour into the dispatcher.** Rules are pure regex; if you need git state (current branch, remote URL), that's a real proposal — open an issue first to discuss the added I/O cost on every Bash call.

## Fixing a rule

If you're chasing a false positive or missed pattern:

1. Reproduce in a test first — add the failing case to `gates.test.ts` so the regression is captured. The fix should make the new case pass without breaking the existing tests.
2. Prefer narrowing the regex over deleting the rule. If the rule is genuinely unsalvageable, delete it cleanly (rule object in `gates.json`, tests, README row, any `NARAI_GATE_DISABLE` guidance) in a single commit.
3. If the false positive is rare and the rule is otherwise valuable, document it under "Limitations" rather than weakening the rule.

## Hook contract

The dispatcher reads stdin and writes stdout per the [Claude Code hook
contract](https://code.claude.com/docs/en/hooks.md). The current shape
the dispatcher relies on:

- **Input**: `{tool_name: "Bash", tool_input: {command: string}, ...}`
- **Output**: `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason: string}}`
- **Exit code**: `0` for any decision (the JSON is the signal). Non-zero is reserved for genuine dispatcher errors (missing `CLAUDE_PLUGIN_ROOT`, missing `plugin-config.json`, etc.).

If Claude Code changes the contract:

1. Update [`plugin-hooks/dispatcher.mjs`](../../plugin-hooks/dispatcher.mjs) and the README's "How it works" section.
2. Bump `version` in `.claude-plugin/plugin.json` and `package.json`.
3. Test against the new Claude Code version with the smoke-test command above before merging.

The dispatcher is shared across every plugin in this repo — contract changes affect them all and need broader review.

## Code conventions

- **`gates.json` is the only file most rule changes touch.** Pure JSON, no JS. Keep formatting consistent with the existing entries.
- **Runtime deps come via `package.json`.** The plugin declares `narai-primitives` as a dep so the SessionStart hook can `npm install` it into `CLAUDE_PLUGIN_DATA` before the dispatcher runs. Don't add other runtime deps without a strong reason.
- **2-space indent.** Tests are TypeScript because Vitest's include glob is `**/*.test.ts`.
- **No emojis** in source or docs (matches repo style).

## Commit + PR hygiene

- Commit messages follow conventional-commits style: `feat(git-connector): ...`, `fix(git-connector): ...`, `docs(git-connector): ...`, `test(git-connector): ...`.
- One logical change per commit. If a rule fix needs a test update and a README update, those go in the same commit.
- Run `npx vitest run tests/plugins/git-connector/` before pushing. The full repo suite (`npx vitest run`) should also pass — the plugin shares the dispatcher with every connector, so dispatcher-touching changes need the broader suite green.
- Open the PR against `main`. The plugin lives outside the connector PR stack and ships independently.

## Out of scope

This plugin deliberately does NOT:

- **Block the command.** The strictest decision is `deny`, which makes Claude refuse and surfaces the reason — but the user can still run the command themselves outside the session. See [SECURITY.md](SECURITY.md) for the full list of bypass paths and why they are intentional.
- **Track git state.** No `git rev-parse`, no remote URL inspection, no branch detection. Rules operate on the literal command string. If you want behaviour gated on current branch (e.g., "deny rebase only when on main"), that's a real proposal — open an issue first to discuss whether the added I/O cost on every Bash call is worth it.
- **Replace branch protection.** Server-side branch protection rules on the remote are the actual enforcement layer. This plugin reduces blast radius from agentic flows; it does not gate the remote.

## License

MIT — see `LICENSE` at the repo root.
