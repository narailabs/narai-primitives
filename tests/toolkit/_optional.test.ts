import { describe, it, expect } from "vitest";
import { importOptional, isBinaryOnPath } from "../../src/toolkit/_optional.js";

describe("importOptional", () => {
  it("returns the module when installed", async () => {
    const zod = await importOptional<typeof import("zod")>("zod");
    expect(typeof zod.z).toBe("object");
  });

  it("throws a friendly error when missing", async () => {
    await expect(
      importOptional("this-package-does-not-exist-123"),
    ).rejects.toThrow(
      /Missing optional dependency 'this-package-does-not-exist-123'/,
    );
    await expect(
      importOptional("this-package-does-not-exist-123"),
    ).rejects.toThrow(/npm install this-package-does-not-exist-123/);
  });
});

describe("isBinaryOnPath", () => {
  it("returns true for a binary that exists (node)", () => {
    expect(isBinaryOnPath("node")).toBe(true);
  });

  it("returns false for a binary that does not exist", () => {
    expect(isBinaryOnPath("this-binary-does-not-exist-zxqw")).toBe(false);
  });
});
