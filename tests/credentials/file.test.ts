/**
 * Tests for FileProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileProvider } from "../../src/credentials/file.js";

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

  describe("getSecretSync", () => {
    it("returns the value for a literal top-level key", () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ token: "ghp_sync" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      expect(provider.getSecretSync("token")).toBe("ghp_sync");
    });

    it("walks a dotted path", () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(
        p,
        JSON.stringify({ "db-prod": { password: "pw-sync" } }),
      );
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      expect(provider.getSecretSync("db-prod.password")).toBe("pw-sync");
    });

    it("returns null on miss", () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ a: "1" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      expect(provider.getSecretSync("absent")).toBeNull();
    });

    it("returns null when the file does not exist", () => {
      const provider = new FileProvider({
        path: path.join(tmpDir, "nope.json"),
        suppressWarning: true,
      });
      expect(provider.getSecretSync("anything")).toBeNull();
    });

    it.skipIf(process.platform === "win32")(
      "refuses a 0644 file synchronously",
      () => {
        const p = path.join(tmpDir, "loose.json");
        fs.writeFileSync(p, JSON.stringify({ token: "nope" }));
        fs.chmodSync(p, 0o644);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const provider = new FileProvider({ path: p });
        expect(() => provider.getSecretSync("token")).toThrow(
          /file mode 644 is group- or world-accessible/,
        );
      },
    );
  });

  describe("describeSecret", () => {
    it("reports exists=true with provider name and lastModified", async () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ token: "v" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      const meta = await provider.describeSecret("token");
      expect(meta.exists).toBe(true);
      expect(meta.provider).toBe("file");
      expect(meta.lastModified).toBeInstanceOf(Date);
      const mtime = fs.statSync(p).mtime.getTime();
      expect(meta.lastModified?.getTime()).toBe(mtime);
    });

    it("reports exists=false for absent keys", async () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ k: "v" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      const meta = await provider.describeSecret("missing");
      expect(meta.exists).toBe(false);
      expect(meta.provider).toBe("file");
    });
  });

  describe("cache TTL", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("caches indefinitely by default (no TTL)", async () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ k: "v1" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      expect(await provider.getSecret("k")).toBe("v1");
      // Rewrite the file; without TTL the provider should keep serving the cached value
      // (rather than re-reading from disk).
      fs.writeFileSync(p, JSON.stringify({ k: "v2" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      vi.advanceTimersByTime(60_000);
      expect(await provider.getSecret("k")).toBe("v1");
      expect(await provider.getSecret("k")).toBe("v1");
    });

    it("re-reads after TTL elapses", async () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ k: "v1" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({
        path: p,
        suppressWarning: true,
        cacheTtlMs: 1000,
      });
      expect(await provider.getSecret("k")).toBe("v1");
      fs.writeFileSync(p, JSON.stringify({ k: "v2" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      // Still within TTL → cached value.
      vi.advanceTimersByTime(500);
      expect(await provider.getSecret("k")).toBe("v1");
      // Past TTL → refreshed value.
      vi.advanceTimersByTime(1000);
      expect(await provider.getSecret("k")).toBe("v2");
    });

    it("clearCache() forces the next call to re-read", async () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ k: "v1" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({ path: p, suppressWarning: true });
      expect(await provider.getSecret("k")).toBe("v1");
      fs.writeFileSync(p, JSON.stringify({ k: "v2" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      provider.clearCache();
      expect(await provider.getSecret("k")).toBe("v2");
    });

    it("parse error on re-read invalidates the cache", async () => {
      const p = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(p, JSON.stringify({ k: "v1" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      const provider = new FileProvider({
        path: p,
        suppressWarning: true,
        cacheTtlMs: 1000,
      });
      expect(await provider.getSecret("k")).toBe("v1");
      fs.writeFileSync(p, "not-valid-json{");
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      vi.advanceTimersByTime(1500);
      await expect(provider.getSecret("k")).rejects.toThrow();
      // After the throw the cache must be gone — fix the file and confirm the next
      // call picks up the new content instead of serving a stale v1.
      fs.writeFileSync(p, JSON.stringify({ k: "v2" }));
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
      expect(await provider.getSecret("k")).toBe("v2");
    });

    it.skipIf(process.platform === "win32")(
      "re-runs mode check on refresh",
      async () => {
        const p = path.join(tmpDir, "secrets.json");
        fs.writeFileSync(p, JSON.stringify({ k: "v1" }));
        fs.chmodSync(p, 0o600);
        const provider = new FileProvider({
          path: p,
          suppressWarning: true,
          cacheTtlMs: 1000,
        });
        expect(await provider.getSecret("k")).toBe("v1");
        fs.chmodSync(p, 0o644);
        vi.advanceTimersByTime(1500);
        await expect(provider.getSecret("k")).rejects.toThrow(
          /file mode 644 is group- or world-accessible/,
        );
      },
    );
  });
});
