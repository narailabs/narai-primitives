import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSiblingInstall } from "../../plugin-hooks/dispatcher.mjs";

describe("findSiblingInstall", () => {
  it("returns null when no siblings exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
    fs.mkdirSync(path.join(tmp, "alone"));
    expect(findSiblingInstall(path.join(tmp, "alone"), "1.0.0")).toBeNull();
    fs.rmSync(tmp, { recursive: true });
  });

  it("returns sibling path when version matches", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
    const me = path.join(tmp, "me");
    const sibling = path.join(tmp, "sibling");
    fs.mkdirSync(me);
    fs.mkdirSync(
      path.join(sibling, "node_modules", "narai-primitives"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(sibling, "node_modules", "narai-primitives", "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    expect(findSiblingInstall(me, "1.0.0")).toBe(
      path.join(sibling, "node_modules"),
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it("returns null when sibling has different version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
    const me = path.join(tmp, "me");
    const sibling = path.join(tmp, "sibling");
    fs.mkdirSync(me);
    fs.mkdirSync(
      path.join(sibling, "node_modules", "narai-primitives"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(sibling, "node_modules", "narai-primitives", "package.json"),
      JSON.stringify({ version: "0.9.0" }),
    );
    expect(findSiblingInstall(me, "1.0.0")).toBeNull();
    fs.rmSync(tmp, { recursive: true });
  });
});
