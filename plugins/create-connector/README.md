# create-connector

A Claude Code skill that scaffolds custom connectors for `narai-primitives`'s `gather()`. Wraps any SaaS API, REST endpoint, GraphQL endpoint, SDK, or CLI tool into a minimal local connector.

## Install

Via the `narai` marketplace:

```sh
/plugin marketplace add narailabs/narai-claude-plugins
/plugin install create-connector@narai
```

## Use

In Claude Code, just describe what you want to wrap:

> "I want to query Stripe from Claude"
> "Wrap our internal orders API"
> "Add Linear to our agents"
> "Make me a Slack connector"

The skill walks you through scope (project vs user), identity, auth, and action surface, then stamps out a minimal local connector at `<scope>/.connectors/connectors/<slug>/`. The `gather()` from `narai-primitives` picks it up immediately — no install, no publish, no restart.

## What you get

```
<scope>/.connectors/connectors/<slug>/
├── SKILL.md         describes actions; read by gather()'s planner
├── index.mjs        uses createConnector from narai-primitives
├── bin/<slug>       shell shim → exec node ../index.mjs
└── (optional) tests/example.test.mjs
```

Plus one entry in `<scope>/.connectors/config.yaml`:

```yaml
connectors:
  <slug>:
    skill: <abs-path>
    bin:   <abs-path>
    enabled: true
```

## Differences from the legacy version

The legacy create-connector flow scaffolded a full `@narai/<svc>-agent-connector` repo with `git init`, `npm install`, plugin manifest, tests/, README, LICENSE, marketplace entry. That flow is now used only for **builtin** connectors that get contributed to `narai-primitives` via PR — see [CONTRIBUTING.md](https://github.com/narailabs/narai-primitives/blob/main/CONTRIBUTING.md).

This skill targets the much more common case: an **end user** who wants a quick local connector for their own work. No git, no publish, no plugin scaffold.
