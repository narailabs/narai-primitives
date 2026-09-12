/**
 * `--params` diagnostics on the dispatcher entry point.
 *
 * A SHAPE error and a SYNTAX error are different problems with different
 * remedies, and they shared one catch: the explicit
 * `params must be a JSON object` throw was rewritten to
 * `Invalid JSON in --params`, telling the caller their JSON was malformed
 * when it parsed perfectly well.
 */
import { describe, expect, it } from "vitest";
import { main } from "../../../src/connectors/db/dispatcher.js";

async function run(params: string): Promise<{ status: number; out: Record<string, unknown> }> {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const status = await main(["--action", "query", "--params", params]);
    return { status, out: JSON.parse(chunks.join("")) as Record<string, unknown> };
  } finally {
    process.stdout.write = orig;
  }
}

describe("dispatcher --params diagnostics", () => {
  it("reports valid JSON of the wrong shape as a shape error", async () => {
    for (const raw of ["[]", "null", '"a string"', "42", "true"]) {
      const { status, out } = await run(raw);
      expect(status).toBe(1);
      expect(out["error_code"]).toBe("VALIDATION_ERROR");
      expect(out["error"]).toBe("params must be a JSON object");
    }
  });

  it("still sanitises a real parser failure", async () => {
    // The parser quotes the offending input verbatim, so `--params
    // "$DB_PASSWORD"` must not survive into the message. Only a position may.
    const { status, out } = await run("hunter2");
    expect(status).toBe(1);
    expect(out["error_code"]).toBe("VALIDATION_ERROR");
    expect(String(out["error"])).not.toContain("hunter2");
    expect(String(out["error"])).toContain("Invalid JSON in --params");
  });
});
