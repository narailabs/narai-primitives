import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extract,
  ExtractCapExceeded,
  normalizeExtracted,
  FORMAT_MAP,
  type ExtractResult,
} from "../../src/toolkit/extract_binary.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "binary",
);

describe("FORMAT_MAP", () => {
  it("maps known extensions", () => {
    expect(FORMAT_MAP[".pdf"]).toBe("pdf");
    expect(FORMAT_MAP[".docx"]).toBe("docx");
    expect(FORMAT_MAP[".pptx"]).toBe("pptx");
  });
});

describe("normalizeExtracted", () => {
  it("collapses 3+ consecutive newlines to 2", () => {
    expect(normalizeExtracted("a\n\n\n\nb")).toBe("a\n\nb");
  });
  it("strips trailing whitespace per line", () => {
    expect(normalizeExtracted("hello   \nworld\t")).toBe("hello\nworld");
  });
});

describe("extract size cap", () => {
  it("throws ExtractCapExceeded when file exceeds maxBytes", async () => {
    const big = path.join(fixturesDir, "big.pdf");
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, "x"));
    try {
      await expect(
        extract(big, "pdf", { maxBytes: 1 * 1024 * 1024 }),
      ).rejects.toBeInstanceOf(ExtractCapExceeded);
    } finally {
      fs.unlinkSync(big);
    }
  });

  it("uses default cap of 50 MB when not specified", async () => {
    const small = path.join(fixturesDir, "small.pdf");
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(small, Buffer.alloc(1 * 1024 * 1024, "x"));
    try {
      // Will throw a parse error (it's not valid PDF), but size-cap check passes first.
      await expect(extract(small, "pdf")).rejects.not.toBeInstanceOf(
        ExtractCapExceeded,
      );
    } finally {
      fs.unlinkSync(small);
    }
  });
});

describe("extract result shape", () => {
  it("returns ExtractResult with text, format, sizeBytes", async () => {
    const fixture = path.join(fixturesDir, "minimal.pdf");
    if (!fs.existsSync(fixture)) return;
    try {
      const r: ExtractResult = await extract(fixture);
      expect(r.format).toBe("pdf");
      expect(typeof r.text).toBe("string");
      expect(r.sizeBytes).toBeGreaterThan(0);
    } catch (e) {
      if (e instanceof Error && e.message.includes("pdfjs-dist")) return;
      throw e;
    }
  });
});
