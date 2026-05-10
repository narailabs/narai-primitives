# Authoring a new flavor

The create-connector skill recognizes 5 flavors today (api-wrapper,
shell-gate, composite, knowledge, custom). Adding a 6th is additive —
the runtime is contract-driven and does not need to know about the
flavor.

## What a flavor is

A flavor is:
- A trigger phrasing the skill listens for in the user's freeform
  description.
- A checklist of shape-specific questions the skill asks once the
  flavor is identified.
- A template directory at
  `plugins/create-connector/skills/create-connector/assets/templates/<flavor>/`
  containing the `.tmpl` files to stamp.

## Adding a flavor

1. Create the template directory: `assets/templates/<flavor>/`.
2. Add `.tmpl` files for each artifact the flavor produces. Use double-
   curly placeholders (`{{SLUG}}`, `{{DESCRIPTION}}`, `{{ServicePascal}}`,
   etc.). Reuse existing placeholder names where the meaning is the same.
3. Add a flavor section in `SKILL.md` with:
   - Trigger phrasings (1-3 examples)
   - Shape-specific questions checklist
   - Which templates get stamped
4. Add tests in `tests/plugins/create-connector/templates.test.ts`
   asserting the new template files exist with the expected placeholders.

## Placeholder conventions

| Placeholder | Substituted with |
|---|---|
| `{{SLUG}}` | lowercase, alphanumeric+hyphen connector slug |
| `{{ServicePascal}}` | PascalCase form of slug for display |
| `{{DESCRIPTION}}` | one-sentence connector description |
| `{{DESCRIPTION_SHORT}}` | brief noun phrase for inline use |
| `{{ACTIONS_TABLE_MD}}` | markdown table of action names + descriptions |
| `{{ACTIONS_DICTIONARY}}` | JS object literal of action handlers (composite) |
| `{{RULES}}` | JSON array of rule objects (shell-gate) |
| `{{RULES_TABLE}}` | markdown table of pattern/decision/reason (shell-gate) |
| `{{DEPENDENCIES}}` | comma-separated list of upstream connectors (composite) |
| `{{DEPENDENCIES_TABLE}}` | markdown table of dependencies (composite) |
| `{{FIRST_ACTION}}` | name of the first action, used in invocation example |
| `{{USE_CASES}}` | bullet list of when to use this connector (knowledge) |
| `{{STEPS}}` | numbered list of runbook steps (knowledge) |
| `{{CAVEATS}}` | bullet list of warnings (knowledge) |

When adding a new placeholder, document it here.

## Custom flavor

For shapes that don't fit a flavor, the skill falls back to pure code-gen.
The skill writes whatever `index.mjs` / `gates.json` / `SKILL.md` makes
sense for the user's description, anchored on the connector contract
(see `connector-contract.md`). No template directory.
