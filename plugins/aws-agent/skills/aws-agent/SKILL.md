---
name: aws-agent
description: |
  Use when the user asks about read-only AWS inventory — Lambda functions,
  RDS databases, S3 buckets, or CloudWatch metrics in an AWS account. Queries
  are scoped to a single region (except list_buckets, which is account-wide).
  Never modifies AWS resources.
context: fork
---

# AWS Agent

Answer the user's question by invoking the `aws-agent` binary exposed by
this plugin. It delegates to `narai-primitives/aws`, which speaks to
AWS via the read-only SDK v3 surface.

## Invocation

```
aws-agent --action <action> --params '<json>'
```

The CLI writes a single JSON envelope to stdout and exits 0 on success, 1 on
a handled error, 2 on CLI misuse. Return the envelope verbatim to the
orchestrator — do not paraphrase or re-format.

## Supported actions

| Action | Required params | Notes |
|---|---|---|
| `list_functions` | `region`, optional `prefix` | Returns Lambda functions in the region, optionally filtered by name prefix |
| `describe_db` | `region`, `db_identifier` | Returns an RDS instance's engine, version, endpoint, storage, and status |
| `list_buckets` | optional `prefix`, optional `region` | Returns S3 buckets across the account |
| `get_metrics` | `region`, `namespace`, `metric_name`, `dimensions`, optional `hours` (default 24, max 168) | CloudWatch datapoints at 5-min resolution |

Example:

```bash
aws-agent --action list_functions --params '{"region":"us-east-1","prefix":"acme-"}'
```

## Envelope shape

Success:
```json
{"status": "success", "action": "<name>", "data": { ... }}
```

Error (handled):
```json
{"status": "error", "action": "<name>", "error_code": "<CODE>", "message": "...", "retriable": true}
```

Known error codes: `VALIDATION_ERROR`, `AUTH_ERROR`, `NOT_FOUND`,
`RATE_LIMITED`, `TIMEOUT`, `CONNECTION_ERROR`, `CONFIG_ERROR`,
`CONFIGURATION_ERROR`.

## Credentials

The connector uses the default AWS credential chain — profiles,
environment variables, instance/container/EKS roles — whichever is
configured on the host. If both `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` are set via `@narai/credential-providers`, those
take precedence.

## Safety

Read-only by construction: only `Describe*`, `List*`, and `Get*` SDK
commands are whitelisted inside the connector. Write/modify operations
cannot be invoked through this skill.
