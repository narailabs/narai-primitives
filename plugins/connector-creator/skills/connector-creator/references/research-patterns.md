# Research patterns for create-connector

The skill is open-ended: the user describes their need in their own
words, and the skill identifies the right connector shape. For
unfamiliar services, the skill researches before asking
shape-specific questions.

## When to research

| User cue | Tool to use |
|---|---|
| Names a SaaS the skill doesn't recognize | `WebFetch` on `<service>.com/docs/api` (or whatever doc URL the user mentions) |
| Mentions a Node/Python library | `context7` for current docs |
| Says "like the jira-agent / aws-agent / etc." | Read the corresponding `src/connectors/<x>/index.ts` for structural reference |
| Vague service description, no URL | `WebSearch` to find the official docs URL, then `WebFetch` |

## What research informs

Research findings inform the *questions* the skill asks. The skill
never decides architectural shape unilaterally based on research — the
user always chooses.

Examples:

- **API wrapper detected** → confirm auth scheme (bearer / api-key /
  basic / oauth), confirm rate limits, ask which actions to expose.
- **Webhook-only service** → push back on user, suggest knowledge-only
  flavor instead since the model can't initiate calls.
- **GraphQL only** → confirm with user, then generate `index.mjs` with
  a thin GraphQL client (no `createConnector`-style typed actions).

## Anti-patterns

Don't:
- Spend 5+ tool calls researching before asking the user. Surface what
  you found in 1-2 fetches and ask the user.
- Pretend to know an API you don't. If the docs are inaccessible, tell
  the user and let them describe the API.
- Auto-classify actions without asking. The user's name for an action
  may not follow the `get_*`/`create_*` convention; confirm intent.

## Reference connectors

For "build me a connector like X", these are the canonical references:

- **REST + bearer auth** → `src/connectors/jira/`
- **REST + multi-secret auth** → `src/connectors/github/`
- **GraphQL** → `src/connectors/linear/` (if PR #17 has merged)
- **Stub pattern (auth pending)** → use the `oauth-with-refresh`
  template from `references/auth-patterns.md`
- **Hook-only / shell-gate** → `plugins/git-connector/hooks/rules.mjs`
