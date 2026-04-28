/**
 * Tests for security_check — URL validation, path containment, label sanitization.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  validateUrl,
  checkPathContainment,
  sanitizeLabel,
} from "../../src/toolkit/security_check.js";
import { makeTmpPath, cleanupTmpPath } from "./fixtures.js";

describe("validateUrl", () => {
  it("accepts http", () => {
    expect(validateUrl("http://example.com")).toBe(true);
  });

  it("accepts https", () => {
    expect(validateUrl("https://example.com")).toBe(true);
  });

  it("accepts HTTP:// (uppercase scheme)", () => {
    expect(validateUrl("HTTP://example.com")).toBe(true);
  });

  it("accepts HtTpS:// (mixed-case scheme)", () => {
    expect(validateUrl("HtTpS://example.com")).toBe(true);
  });

  it("rejects file://", () => {
    expect(validateUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects FILE:// (uppercase disallowed scheme)", () => {
    expect(validateUrl("FILE:///etc/passwd")).toBe(false);
  });

  it("rejects data:", () => {
    expect(validateUrl("data:text/html,<h1>hi</h1>")).toBe(false);
  });

  it("rejects ftp://", () => {
    expect(validateUrl("ftp://server/file")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateUrl("")).toBe(false);
  });

  it("rejects leading-whitespace URL (fails closed)", () => {
    expect(validateUrl(" http://example.com")).toBe(false);
  });
});

describe("checkPathContainment", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = makeTmpPath("sec-check-");
  });

  afterEach(() => {
    cleanupTmpPath(tmpPath);
  });

  it("path_inside_wiki_root_passes", () => {
    const wikiRoot = path.join(tmpPath, "wiki-root");
    fs.mkdirSync(wikiRoot);
    const pageDir = path.join(wikiRoot, "wiki");
    fs.mkdirSync(pageDir, { recursive: true });
    const page = path.join(pageDir, "page.md");
    fs.writeFileSync(page, "");
    expect(checkPathContainment(page, wikiRoot)).toBe(true);
  });

  it("path_outside_wiki_root_fails", () => {
    const wikiRoot = path.join(tmpPath, "wiki-root");
    fs.mkdirSync(wikiRoot);
    const evilPath = path.join(wikiRoot, "..", "..", "etc", "passwd");
    expect(checkPathContainment(evilPath, wikiRoot)).toBe(false);
  });

  it("symlink_traversal_fails", () => {
    const wikiRoot = path.join(tmpPath, "wiki-root");
    fs.mkdirSync(wikiRoot);
    const outside = path.join(tmpPath, "outside");
    fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");

    const link = path.join(wikiRoot, "sneaky_link");
    fs.symlinkSync(secret, link);

    expect(checkPathContainment(link, wikiRoot)).toBe(false);
  });

  it("symlink_at_ancestor_level_fails", () => {
    // The sneaky symlink is an intermediate directory, not the leaf:
    // the leaf file itself does not exist, so bestEffortRealpath must
    // walk up, realpath the symlinked ancestor, then re-append the tail.
    const wikiRoot = path.join(tmpPath, "wiki-root");
    fs.mkdirSync(wikiRoot);
    const outside = path.join(tmpPath, "outside");
    fs.mkdirSync(outside);

    const intermediateLink = path.join(wikiRoot, "sneaky_dir");
    fs.symlinkSync(outside, intermediateLink);

    const leaf = path.join(intermediateLink, "file.md");
    expect(checkPathContainment(leaf, wikiRoot)).toBe(false);
  });

  it("symlink_cycle_fails_closed", () => {
    const wikiRoot = path.join(tmpPath, "wiki-root");
    fs.mkdirSync(wikiRoot);
    const a = path.join(wikiRoot, "link-a");
    const b = path.join(wikiRoot, "link-b");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(checkPathContainment(a, wikiRoot)).toBe(false);
  });

  it("relative_traversal_resolves_against_cwd_and_fails", () => {
    const wikiRoot = path.join(tmpPath, "wiki-root");
    fs.mkdirSync(wikiRoot);
    // Relative paths are resolved against process.cwd(), which is the
    // repo root — nowhere near tmpPath — so containment must be false.
    expect(checkPathContainment("../../../../../../etc/passwd", wikiRoot)).toBe(false);
  });
});

describe("sanitizeLabel", () => {
  it("strips_C0_control_chars", () => {
    const result = sanitizeLabel("hello\x00\x01world");
    expect(result).not.toContain("\x00");
    expect(result).not.toContain("\x01");
    expect(result).toContain("helloworld");
  });

  it("strips_DEL_0x7F", () => {
    const result = sanitizeLabel("hi\u007Fthere");
    expect(result).toBe("hithere");
  });

  it("strips_C1_control_chars", () => {
    const result = sanitizeLabel("x\u0080y\u009Fz");
    expect(result).toBe("xyz");
  });

  it("caps_length_at_default_256", () => {
    const longLabel = "a".repeat(500);
    const result = sanitizeLabel(longLabel);
    expect(result.length).toBeLessThanOrEqual(256);
  });

  it("respects_custom_maxLength", () => {
    // Slice happens before htmlEscape, so a custom max applies to the
    // pre-escape character count.
    expect(sanitizeLabel("abcdefghij", 5)).toBe("abcde");
  });

  it("html_escapes", () => {
    const result = sanitizeLabel("<script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });
});
