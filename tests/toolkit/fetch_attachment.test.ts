import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAttachment } from "../../src/toolkit/fetch_attachment.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "binary",
);

function makeFetch(
  body: Uint8Array | string,
  headers: Record<string, string>,
): typeof fetch {
  return (async () =>
    new Response(body, { status: 200, headers })) as unknown as typeof fetch;
}

describe("fetchAttachment", () => {
  it("extracts text/* directly", async () => {
    const r = await fetchAttachment("https://example.com/a.txt", {
      fetchImpl: makeFetch("hello world", {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="a.txt"',
      }),
    });
    expect(r.extracted.format).toBe("text");
    expect(r.extracted.text).toBe("hello world");
    expect(r.filename).toBe("a.txt");
    expect(r.contentType).toBe("text/plain");
    expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dispatches application/pdf through extractBinary", async () => {
    const bytes = fs.readFileSync(path.join(fixturesDir, "minimal.pdf"));
    const r = await fetchAttachment("https://example.com/a.pdf", {
      fetchImpl: makeFetch(bytes, { "content-type": "application/pdf" }),
    });
    expect(["pdf", "skipped"]).toContain(r.extracted.format);
    if (r.extracted.format === "skipped") {
      expect(r.extracted.warning).toMatch(/pdfjs-dist|Missing optional/);
    }
  });

  it("skips unknown mime types", async () => {
    const r = await fetchAttachment("https://example.com/a.bin", {
      fetchImpl: makeFetch(new Uint8Array([1, 2, 3]), {
        "content-type": "application/octet-stream",
      }),
    });
    expect(r.extracted.format).toBe("skipped");
    expect(r.extracted.warning).toMatch(/application\/octet-stream/);
  });

  it("rejects invalid URL schemes", async () => {
    await expect(
      fetchAttachment("file:///etc/passwd", {
        fetchImpl: makeFetch("", { "content-type": "text/plain" }),
      }),
    ).rejects.toThrow();
  });
});
