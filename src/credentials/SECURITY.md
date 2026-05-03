# Security Policy

## Reporting a Vulnerability

Please report suspected security vulnerabilities by emailing
`security@narailabs.com`. Include a description of the issue, the affected
version, and steps to reproduce. We aim to acknowledge reports within a
few business days.

Please do not open public GitHub issues for security-sensitive reports.

## Supported Versions

This project is pre-1.0. Only the latest published minor release receives
security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Scope

Credential *values* retrieved by this library are never logged by the
library itself. Error messages and thrown errors may include:

- secret *names* (e.g. the key being looked up in a provider),
- filesystem paths (e.g. the path to a JSON credentials file),
- provider identifiers (e.g. `env`, `keychain`, `aws`).

Callers that log errors should be aware of this and redact as appropriate
for their environment.

## Out of Scope

Vulnerabilities in optional peer SDKs — including `@aws-sdk/*`,
`@google-cloud/*`, and `@azure/*` packages — should be reported to their
respective upstream maintainers rather than to this project.
