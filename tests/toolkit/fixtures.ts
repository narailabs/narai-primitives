/**
 * Shared test fixtures for the connector-toolkit test suite.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Create a fresh temp directory and return its path. */
export function makeTmpPath(prefix: string = "connector-toolkit-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Best-effort recursive remove of a temp directory. */
export function cleanupTmpPath(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
