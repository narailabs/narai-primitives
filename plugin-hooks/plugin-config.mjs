/**
 * Parse and validate a plugin-config.json string.
 *
 * Shape:
 *   { name: string,
 *     binPath?: string,
 *     kind?: "connector" | "db" | "hook-only",
 *     enforcement?: "fail_open" | "fail_closed" }
 *
 * `enforcement` declares the default fail-closed posture for this plugin's
 * gate evaluation, so an operator can set it once in config instead of
 * exporting NARAI_GATE_ENFORCEMENT on every hook invocation. Absent ⇒ the
 * dispatcher falls through to the env var (default fail_open).
 */
const VALID_KINDS = new Set(["connector", "db", "hook-only"]);
const VALID_ENFORCEMENT = new Set(["fail_open", "fail_closed"]);

export function parsePluginConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`plugin-config.json: invalid JSON — ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("plugin-config.json: expected an object");
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error("plugin-config.json: 'name' must be a non-empty string");
  }
  if (parsed.binPath !== undefined && typeof parsed.binPath !== "string") {
    throw new Error("plugin-config.json: 'binPath' must be a string");
  }
  if (parsed.kind !== undefined && !VALID_KINDS.has(parsed.kind)) {
    throw new Error(
      `plugin-config.json: 'kind' must be one of ${[...VALID_KINDS].join(", ")}`,
    );
  }
  if (
    parsed.enforcement !== undefined &&
    !VALID_ENFORCEMENT.has(parsed.enforcement)
  ) {
    throw new Error(
      `plugin-config.json: 'enforcement' must be one of ${[...VALID_ENFORCEMENT].join(", ")}`,
    );
  }
  const out = { name: parsed.name };
  if (parsed.binPath !== undefined) out.binPath = parsed.binPath;
  if (parsed.kind !== undefined) out.kind = parsed.kind;
  if (parsed.enforcement !== undefined) out.enforcement = parsed.enforcement;
  return out;
}
