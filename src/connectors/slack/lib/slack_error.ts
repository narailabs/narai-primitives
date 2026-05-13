/**
 * slack_error.ts — Slack-specific error alias.
 *
 * Re-export of the toolkit's `ConnectorError` under a service-specific name
 * so callers can `import { SlackError }` and `err instanceof SlackError`
 * keeps reading naturally. The underlying class is shared across connectors;
 * the alias is just for ergonomics.
 */
export { ConnectorError as SlackError } from "narai-primitives/toolkit";
