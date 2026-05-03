/**
 * Tests for EnvVarProvider.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvVarProvider } from "../src/env_var.js";

describe("credential_providers/env_var", () => {
  const saved: Record<string, string | undefined> = {};

  function setEnv(k: string, v: string | undefined): void {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeEach(() => {
    for (const k of Object.keys(saved)) delete saved[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("finds a literal match", async () => {
    setEnv("GITHUB_TOKEN", "ghp_xyz");
    const p = new EnvVarProvider();
    expect(await p.getSecret("GITHUB_TOKEN")).toBe("ghp_xyz");
  });

  it("normalizes to upper-snake-case", async () => {
    setEnv("GITHUB_TOKEN", "ghp_abc");
    const p = new EnvVarProvider();
    expect(await p.getSecret("github.token")).toBe("ghp_abc");
    expect(await p.getSecret("github-token")).toBe("ghp_abc");
    expect(await p.getSecret("Github Token")).toBe("ghp_abc");
  });

  it("returns null when nothing matches", async () => {
    setEnv("PRESENT_VAR", "x");
    setEnv("ABSENT_VAR", undefined);
    const p = new EnvVarProvider();
    expect(await p.getSecret("absent-var")).toBeNull();
  });

  it("treats empty string as a miss", async () => {
    setEnv("EMPTY_VAR", "");
    const p = new EnvVarProvider();
    expect(await p.getSecret("empty-var")).toBeNull();
  });

  it("honors prefix when provided", async () => {
    setEnv("MYAPP_DEV_USER", "admin");
    const p = new EnvVarProvider({ prefix: "MYAPP_" });
    expect(await p.getSecret("dev_user")).toBe("admin");
  });

  it("describeSecret reports exists=true for present values", async () => {
    setEnv("PRESENT_VAR", "v");
    const p = new EnvVarProvider();
    expect(await p.describeSecret("PRESENT_VAR")).toEqual({
      exists: true,
      provider: "env_var",
    });
  });

  it("describeSecret reports exists=false for absent values", async () => {
    setEnv("ABSENT_VAR", undefined);
    const p = new EnvVarProvider();
    expect(await p.describeSecret("ABSENT_VAR")).toEqual({
      exists: false,
      provider: "env_var",
    });
  });

  describe("getSecretSync", () => {
    it("finds a literal match synchronously", () => {
      setEnv("GITHUB_TOKEN", "ghp_sync");
      const p = new EnvVarProvider();
      expect(p.getSecretSync("GITHUB_TOKEN")).toBe("ghp_sync");
    });

    it("normalizes synchronously", () => {
      setEnv("GITHUB_TOKEN", "ghp_sync_norm");
      const p = new EnvVarProvider();
      expect(p.getSecretSync("github.token")).toBe("ghp_sync_norm");
      expect(p.getSecretSync("github-token")).toBe("ghp_sync_norm");
    });

    it("returns null on miss", () => {
      setEnv("ABSENT_SYNC_VAR", undefined);
      const p = new EnvVarProvider();
      expect(p.getSecretSync("absent-sync-var")).toBeNull();
    });

    it("treats empty string as a miss", () => {
      setEnv("EMPTY_SYNC_VAR", "");
      const p = new EnvVarProvider();
      expect(p.getSecretSync("empty-sync-var")).toBeNull();
    });

    it("honors prefix", () => {
      setEnv("MYAPP_SYNC_USER", "admin-sync");
      const p = new EnvVarProvider({ prefix: "MYAPP_" });
      expect(p.getSecretSync("sync_user")).toBe("admin-sync");
    });
  });
});
