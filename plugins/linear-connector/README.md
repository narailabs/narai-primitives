# linear-connector plugin

Claude Code plugin for the Linear connector. Exposes the `linear-connector` binary
that delegates to `narai-primitives/linear` — a GraphQL-based connector with
7 read actions and 7 write actions for Linear issues, comments, and attachments.

## Environment variables

| Variable          | Description                        |
|-------------------|------------------------------------|
| `LINEAR_API_KEY`  | Linear personal API key (no Bearer prefix — Linear is opinionated) |

Obtain your API key from Linear → Settings → API → Personal API keys.

## Credentials note

The connector reads `LINEAR_API_KEY` from the environment. You can also
register a credential provider via `narai-primitives/credentials`, or
configure it under `connectors.linear.options.api_key` in
`~/.connectors/config.yaml`.

The authorization header sent to `https://api.linear.app/graphql` is:

```
Authorization: <api_key>
```

Note: Linear does **not** use a `Bearer` prefix — this is Linear-specific
and differs from most REST APIs.
