# aws-agent-plugin

Claude Code plugin that wraps [`@narai/aws-agent-connector`](https://www.npmjs.com/package/@narai/aws-agent-connector) as a read-only AWS skill and slash command.

## What it adds

- **Skill** `aws-agent` — invoked automatically when the model is asked about AWS Lambda, RDS, S3, or CloudWatch.
- **Slash command** `/aws-agent <action> <params-json>` — explicit invocation.
- **Binary** `aws-agent` — thin shell shim that exec's the installed connector CLI.

## How install works

Claude Code plugins don't run `npm install`. On first `SessionStart` the
hook in `hooks/hooks.json`:

1. compares the plugin's `package.json` with whatever is in
   `${CLAUDE_PLUGIN_DATA}/`;
2. if different or missing, copies the manifest and runs
   `npm install --no-audit --no-fund` inside `${CLAUDE_PLUGIN_DATA}`;
3. if the install fails, removes the stale copy so the hook re-runs
   next session.

After a successful install,
`${CLAUDE_PLUGIN_DATA}/node_modules/@narai/aws-agent-connector/dist/cli.js`
exists and `bin/aws-agent` can exec it.

## Usage

Inside Claude Code:

```
/aws-agent list_functions {"region":"us-east-1","prefix":"acme-"}
```

Or let the `aws-agent` skill be triggered automatically by asking about
AWS resources.

## AWS credentials

The connector uses the default AWS credential chain — profiles, env
vars, instance roles, and so on. No credentials are stored by this
plugin.

## License

MIT
