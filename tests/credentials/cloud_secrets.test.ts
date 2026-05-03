/**
 * Tests for CloudSecretsProvider. We inject pre-built mock SDK clients via
 * the `forTesting` factory so the tests never load real SDKs or touch the
 * network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSecretsProvider } from "../../src/credentials/cloud_secrets.js";

describe("credential_providers/cloud_secrets", () => {
  describe("aws sub-provider", () => {
    it("returns SecretString from GetSecretValueCommand", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "aws-secret" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      expect(await p.getSecret("db-password")).toBe("aws-secret");
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("returns null when ResourceNotFoundException is thrown", async () => {
      const err = Object.assign(new Error("missing"), {
        name: "ResourceNotFoundException",
      });
      const send = vi.fn().mockRejectedValue(err);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      expect(await p.getSecret("absent")).toBeNull();
    });

    it("decodes SecretBinary to UTF-8 when present", async () => {
      const send = vi.fn().mockResolvedValue({
        SecretBinary: new TextEncoder().encode("binary-secret"),
      });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      expect(await p.getSecret("x")).toBe("binary-secret");
    });

    it("rethrows non-not-found errors", async () => {
      const send = vi.fn().mockRejectedValue(new Error("kaboom"));
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      await expect(p.getSecret("x")).rejects.toThrow(/kaboom/);
    });
  });

  describe("gcp sub-provider", () => {
    it("reads the secret and decodes the payload", async () => {
      const accessSecretVersion = vi.fn().mockResolvedValue([
        { payload: { data: new TextEncoder().encode("gcp-secret") } },
      ]);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "gcp",
        gcpProjectId: "proj-1",
        client: { accessSecretVersion },
      });
      expect(await p.getSecret("api-key")).toBe("gcp-secret");
      expect(accessSecretVersion).toHaveBeenCalledWith({
        name: "projects/proj-1/secrets/api-key/versions/latest",
      });
    });

    it("supports gcpVersion override", async () => {
      const accessSecretVersion = vi.fn().mockResolvedValue([
        { payload: { data: "v7-value" } },
      ]);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "gcp",
        gcpProjectId: "proj-1",
        gcpVersion: "7",
        client: { accessSecretVersion },
      });
      await p.getSecret("api-key");
      expect(accessSecretVersion).toHaveBeenCalledWith({
        name: "projects/proj-1/secrets/api-key/versions/7",
      });
    });

    it("returns null on NOT_FOUND (grpc code 5)", async () => {
      const err = Object.assign(new Error("not found"), { code: 5 });
      const accessSecretVersion = vi.fn().mockRejectedValue(err);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "gcp",
        gcpProjectId: "p",
        client: { accessSecretVersion },
      });
      expect(await p.getSecret("x")).toBeNull();
    });

    it("rejects names with forbidden characters before calling the client", async () => {
      const accessSecretVersion = vi.fn();
      const p = CloudSecretsProvider.forTesting({
        subProvider: "gcp",
        gcpProjectId: "proj-1",
        client: { accessSecretVersion },
      });
      await expect(
        p.getSecret("../../other-proj/secrets/victim"),
      ).rejects.toThrow(/invalid secret name/);
      expect(accessSecretVersion).not.toHaveBeenCalled();
    });
  });

  describe("azure sub-provider", () => {
    it("reads via getSecret()", async () => {
      const getSecret = vi.fn().mockResolvedValue({ value: "azure-secret" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "azure",
        azureVaultUrl: "https://my.vault.azure.net",
        client: { getSecret },
      });
      expect(await p.getSecret("cert-key")).toBe("azure-secret");
      expect(getSecret).toHaveBeenCalledWith("cert-key");
    });

    it("returns null on SecretNotFound", async () => {
      const err = Object.assign(new Error("nope"), { code: "SecretNotFound" });
      const getSecret = vi.fn().mockRejectedValue(err);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "azure",
        azureVaultUrl: "https://my.vault.azure.net",
        client: { getSecret },
      });
      expect(await p.getSecret("x")).toBeNull();
    });

    it("returns null on statusCode 404", async () => {
      const err = Object.assign(new Error("nope"), { statusCode: 404 });
      const getSecret = vi.fn().mockRejectedValue(err);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "azure",
        azureVaultUrl: "https://my.vault.azure.net",
        client: { getSecret },
      });
      expect(await p.getSecret("x")).toBeNull();
    });
  });

  describe("config validation", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("throws when awsRegion is missing and no client is injected", async () => {
      const p = new CloudSecretsProvider({ subProvider: "aws" });
      await expect(p.getSecret("x")).rejects.toThrow(/awsRegion is required/);
    });

    it("throws when gcpProjectId is missing and no client is injected", async () => {
      const p = new CloudSecretsProvider({ subProvider: "gcp" });
      await expect(p.getSecret("x")).rejects.toThrow(
        /gcpProjectId is required/,
      );
    });

    it("throws when azureVaultUrl is missing and no client is injected", async () => {
      const p = new CloudSecretsProvider({ subProvider: "azure" });
      await expect(p.getSecret("x")).rejects.toThrow(
        /azureVaultUrl is required/,
      );
    });
  });

  describe("TTL cache", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns cached value within TTL without re-calling the SDK", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "v1" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        cacheTtlMs: 60_000,
        client: { send },
      });
      expect(await p.getSecret("k")).toBe("v1");
      vi.advanceTimersByTime(30_000);
      expect(await p.getSecret("k")).toBe("v1");
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("re-calls the SDK once the TTL expires", async () => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ SecretString: "v1" })
        .mockResolvedValueOnce({ SecretString: "v2" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        cacheTtlMs: 1_000,
        client: { send },
      });
      expect(await p.getSecret("k")).toBe("v1");
      vi.advanceTimersByTime(1_500);
      expect(await p.getSecret("k")).toBe("v2");
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("caches null misses", async () => {
      const err = Object.assign(new Error("missing"), {
        name: "ResourceNotFoundException",
      });
      const send = vi.fn().mockRejectedValue(err);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        cacheTtlMs: 60_000,
        client: { send },
      });
      expect(await p.getSecret("absent")).toBeNull();
      expect(await p.getSecret("absent")).toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not cache thrown errors", async () => {
      const send = vi
        .fn()
        .mockRejectedValueOnce(new Error("kaboom"))
        .mockResolvedValueOnce({ SecretString: "v1" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        cacheTtlMs: 60_000,
        client: { send },
      });
      await expect(p.getSecret("k")).rejects.toThrow(/kaboom/);
      expect(await p.getSecret("k")).toBe("v1");
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("clearCache() forces a re-fetch", async () => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ SecretString: "v1" })
        .mockResolvedValueOnce({ SecretString: "v2" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        cacheTtlMs: 60_000,
        client: { send },
      });
      expect(await p.getSecret("k")).toBe("v1");
      p.clearCache();
      expect(await p.getSecret("k")).toBe("v2");
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("with default cacheTtlMs (0), every call hits the SDK", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "v1" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      await p.getSecret("k");
      await p.getSecret("k");
      await p.getSecret("k");
      expect(send).toHaveBeenCalledTimes(3);
    });
  });

  describe("describeSecret", () => {
    it("reports exists=true for present keys", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "v" });
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      expect(await p.describeSecret("present")).toEqual({
        exists: true,
        provider: "cloud_secrets",
      });
    });

    it("reports exists=false when the backend raises not-found", async () => {
      const err = Object.assign(new Error("missing"), {
        name: "ResourceNotFoundException",
      });
      const send = vi.fn().mockRejectedValue(err);
      const p = CloudSecretsProvider.forTesting({
        subProvider: "aws",
        awsRegion: "us-east-1",
        client: { send },
      });
      expect(await p.describeSecret("absent")).toEqual({
        exists: false,
        provider: "cloud_secrets",
      });
    });
  });
});
