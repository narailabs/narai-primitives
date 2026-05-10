/**
 * Parse and validate a plugin-config.json string.
 *
 * Shape:
 *   { name: string,
 *     binPath?: string,
 *     kind?: "connector" | "db" | "hook-only" }
 */
const VALID_KINDS = new Set(["connector", "db", "hook-only"]);

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
  const out = { name: parsed.name };
  if (parsed.binPath !== undefined) out.binPath = parsed.binPath;
  if (parsed.kind !== undefined) out.kind = parsed.kind;
  return out;
}
