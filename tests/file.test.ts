/**
 * Tests for FileProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileProvider } from "../src/file.js";

describe("credential_providers/file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-file-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads a secret from a JSON file", async () => {
    const p = path.join(tmpDir, "secrets.json");
    fs.writeFileSync(p, JSON.stringify({ github_token: "ghp_abc" }));
    if (process.platform !== "win32") fs.chmodSync(p, 0o600);
    const provider = new FileProvider({ path: p, suppressWarning: true });
    expect(await provider.getSecret("github_token")).toBe("ghp_abc");
  });

  it("returns null on missing secret", async () => {
    const p = path.join(tmpDir, "secrets.json");
    fs.writeFileSync(p, JSON.stringify({ a: "1" }));
    if (process.platform !== "win32") fs.chmodSync(p, 0o600);
    const provider = new FileProvider({ path: p, suppressWarning: true });
    expect(await provider.getSecret("missing")).toBeNull();
  });

  it("returns null when the file does not exist", async () => {
    const provider = new FileProvider({
      path: path.join(tmpDir, "nope.json"),
      suppressWarning: true,
    });
    expect(await provider.getSecret("anything")).toBeNull();
  });

  it("throws on non-object JSON", async () => {
    const p = path.join(tmpDir, "secrets.json");
    fs.writeFileSync(p, JSON.stringify(["not", "an", "object"]));
    if (process.platform !== "win32") fs.chmodSync(p, 0o600);
    const provider = new FileProvider({ path: p, suppressWarning: true });
    await expect(provider.getSecret("k")).rejects.toThrow(/JSON object/);
  });

  it("warns once (not every call) when unsuppressed", async () => {
    const p = path.join(tmpDir, "secrets.json");
    fs.writeFileSync(p, JSON.stringify({ x: "1" }));
    fs.chmodSync(p, 0o600); // satisfy mode check
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new FileProvider({ path: p });
    await provider.getSecret("x");
    await provider.getSecret("x");
    await provider.getSecret("missing");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")(
    "refuses to read a credentials file with group- or world-accessible mode",
    async () => {
      const p = path.join(tmpDir, "loose.json");
      fs.writeFileSync(p, JSON.stringify({ token: "ghp_x" }));
      fs.chmodSync(p, 0o644);
      const provider = new FileProvider({ path: p }); // not suppressed
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(provider.getSecret("token")).rejects.toThrow(
        /file mode 644 is group- or world-accessible/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts a credentials file with mode 0600",
    async () => {
      const p = path.join(tmpDir, "tight.json");
      fs.writeFileSync(p, JSON.stringify({ token: "ghp_y" }));
      fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await provider.getSecret("token")).toBe("ghp_y");
    },
  );

  it("ignores non-string values", async () => {
    const p = path.join(tmpDir, "secrets.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ strval: "ok", numval: 42, nested: { a: 1 } }),
    );
    if (process.platform !== "win32") fs.chmodSync(p, 0o600);
    const provider = new FileProvider({ path: p, suppressWarning: true });
    expect(await provider.getSecret("strval")).toBe("ok");
    expect(await provider.getSecret("numval")).toBeNull();
    expect(await provider.getSecret("nested")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "still enforces mode check when suppressWarning is true",
    async () => {
      const p = path.join(tmpDir, "loose-suppressed.json");
      fs.writeFileSync(p, JSON.stringify({ token: "ghp_z" }));
      fs.chmodSync(p, 0o644);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      await expect(provider.getSecret("token")).rejects.toThrow(
        /file mode 644 is group- or world-accessible/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows loose permissions when allowLoosePermissions is true",
    async () => {
      const p = path.join(tmpDir, "loose-allowed.json");
      fs.writeFileSync(p, JSON.stringify({ token: "ghp_w" }));
      fs.chmodSync(p, 0o644);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileProvider({
        path: p,
        allowLoosePermissions: true,
      });
      expect(await provider.getSecret("token")).toBe("ghp_w");
    },
  );
});
