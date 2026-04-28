const ACTION_RE = /--action\s+([A-Za-z0-9_-]+)/;

/** Extract the value after `--action` from a Bash command string. */
export function parseAction(command: string): string {
  const m = command.match(ACTION_RE);
  return m?.[1] ?? "unknown";
}

/** Extract top-level `status` field from a connector envelope JSON string. */
export function parseStatus(stdout: string): string {
  if (!stdout) return "unparseable";
  try {
    const parsed = JSON.parse(stdout) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : "unparseable";
  } catch {
    return "unparseable";
  }
}
