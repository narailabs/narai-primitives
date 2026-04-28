export type TokenMethod = "heuristic" | "gpt-4o";

export interface TokenResult {
  count: number;
  method: TokenMethod;
}

function heuristic(text: string): TokenResult {
  return { count: Math.ceil(Buffer.byteLength(text, "utf-8") / 4), method: "heuristic" };
}

/**
 * Count tokens for a text payload. Best-effort: if the selected tokenizer is
 * unavailable, falls back to the heuristic. Never throws.
 */
export async function encodeTokens(
  text: string,
  method: TokenMethod | string,
): Promise<TokenResult> {
  if (method !== "gpt-4o") return heuristic(text);

  try {
    // Dynamic import: `gpt-tokenizer` is an optionalDependency; absence must
    // degrade silently to the heuristic.
    const mod = (await import("gpt-tokenizer")) as unknown as {
      encode?: (s: string) => number[];
      encodeChat?: unknown;
    };
    if (typeof mod.encode !== "function") return heuristic(text);
    const tokens = mod.encode(text);
    return { count: tokens.length, method: "gpt-4o" };
  } catch {
    return heuristic(text);
  }
}
