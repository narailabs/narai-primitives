#!/usr/bin/env node
/**
 * db-agent-connector CLI bin entry.
 *
 * Framework-backed: main() + fetch() come from `buildDbConnector()` (see
 * connector.ts). The internal dispatcher still handles all DB-specific
 * work; this file is just the CLI harness.
 *
 * `main` is re-exported so existing tests can invoke it programmatically.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import connector from "./index.js";

export const main = connector.main;
export const fetch = connector.fetch;
export const VALID_ACTIONS = connector.validActions;

function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const scriptPath = fs.realpathSync(path.resolve(argv1));
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
