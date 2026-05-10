# Connector contract

A connector is a directory at `<scope>/.connectors/connectors/<slug>/` that
satisfies a thin contract. The runtime treats unknown files as opaque, so
flavors can extend the layout without changing the contract.

## Required

- `SKILL.md` — model-facing description (frontmatter `name`, `description`,
  `context: connector`). The skill describes when to invoke this connector
  and what params it accepts.
- Entry in `<scope>/.connectors/config.yaml` under `connectors:`:
  ```yaml
  connectors:
    <slug>:
      skill: <abs-path-to-connector-dir>
      bin:   <abs-path-to-bin-or-null>
      enabled: true
  ```

## Optional (any combination)

- `index.mjs` — programmatic actions, built with `createConnector` from
  `narai-primitives/toolkit`. Gives you the toolkit's policy gate,
  classification, audit, and hardship logging for free. Invoked via
  `gather()` or directly via the bin shim.
- `gates.json` — declarative shell-command gates fired at PreToolUse:
  ```json
  {
    "rules": [
      { "name": "deny_x", "decision": "deny|ask|allow",
        "reason": "...", "pattern": "<regex>" }
    ]
  }
  ```
  The runtime applies each rule's regex to the bash command (split on
  `&&`/`||`/`;`/`|`); strictest decision wins (`deny` > `ask` > `allow`).
- `bin/<slug>` — CLI shim that execs `index.mjs`. Required if `index.mjs`
  is present.
- (nothing) — knowledge-only connector. Just SKILL.md + config.yaml entry.

## How the runtime finds connectors

Two firing points:

1. **Standalone runtime** — `connector-gate.mjs` at `<scope>/.connectors/`,
   wired into `<scope>/.claude/settings.json` as a `PreToolUse` hook. Reads
   `<scope>/.connectors/connectors/*/gates.json` and applies decisions.
2. **Builtin Claude Code plugin** — when any narai builtin plugin is
   installed (jira-agent, aws-agent, etc.), its dispatcher *also* discovers
   user connectors at the same path and applies their gates. Defense in
   depth.

If both fire, `deny` precedence ensures consistency.

## File-tree example

```
<scope>/
├── .claude/
│   └── settings.json              # PreToolUse hook → connector-gate.mjs
└── .connectors/
    ├── config.yaml                # connector registry
    ├── connector-gate.mjs         # standalone runtime (stamped on first /create-connector)
    └── connectors/
        ├── stripe/                # API/SDK wrapper
        │   ├── SKILL.md
        │   ├── index.mjs
        │   └── bin/stripe
        ├── deploy-prod/           # shell-gate
        │   ├── SKILL.md
        │   └── gates.json
        ├── linear-summary/        # composite orchestrator
        │   ├── SKILL.md
        │   ├── index.mjs
        │   └── bin/linear-summary
        └── runbook-ssh/           # knowledge-only
            └── SKILL.md
```
