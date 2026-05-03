/**
 * Tests for KeychainProvider. We mock `node:child_process.execFileSync`
 * (for macOS/Linux backends) and `@napi-rs/keyring` (for Windows) so the
 * suite never touches a real keychain and can run on any host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Windows backend uses a lazy dynamic import of `@napi-rs/keyring`. Use
// `vi.hoisted` so the shared state is initialized before the hoisted
// `vi.mock` factory below runs (vitest hoists `vi.mock` calls to the top
// of the file, above regular declarations). `Entry` is used with `new`,
// so we return a real class that delegates to `keyringMocks.impl` and
// records every construction on `keyringMocks.ctor` for assertions.
const keyringMocks = vi.hoisted(() => {
  const state: {
    impl:
      | ((service: string, account: string) => {
          getPassword(): string | null;
        })
      | null;
    ctor: ReturnType<typeof vi.fn>;
  } = { impl: null, ctor: vi.fn() };
  return state;
});
vi.mock("@napi-rs/keyring", () => {
  class Entry {
    private readonly _inner: { getPassword(): string | null };
    constructor(service: string, account: string) {
      keyringMocks.ctor(service, account);
      if (!keyringMocks.impl) {
        throw new Error("keyringMocks.impl not set");
      }
      this._inner = keyringMocks.impl(service, account);
    }
    getPassword(): string | null {
      return this._inner.getPassword();
    }
  }
  return { Entry };
});

import { execFileSync } from "node:child_process";
import { KeychainProvider } from "../../src/credentials/keychain.js";

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe("credential_providers/keychain", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("macOS", () => {
    it("reads via `security find-generic-password -s <name> -w`", async () => {
      execMock.mockReturnValueOnce("secret-value\n");
      const p = new KeychainProvider({ platform: "darwin" });
      expect(await p.getSecret("MY_SECRET")).toBe("secret-value");
      expect(execMock).toHaveBeenCalledWith(
        "security",
        ["find-generic-password", "-s", "MY_SECRET", "-w"],
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("passes -a <account> when provided", async () => {
      execMock.mockReturnValueOnce("val\n");
      const p = new KeychainProvider({
        platform: "darwin",
        account: "alice",
      });
      await p.getSecret("SECRET");
      expect(execMock).toHaveBeenCalledWith(
        "security",
        ["find-generic-password", "-a", "alice", "-s", "SECRET", "-w"],
        expect.any(Object),
      );
    });

    it("applies servicePrefix", async () => {
      execMock.mockReturnValueOnce("v\n");
      const p = new KeychainProvider({
        platform: "darwin",
        servicePrefix: "com.example.myapp",
      });
      await p.getSecret("github");
      const [, args] = execMock.mock.calls[0] as [string, string[]];
      expect(args).toContain("com.example.myapp.github");
    });

    it("returns null when security exits 44 (not-found)", async () => {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 44;
      execMock.mockImplementationOnce(() => {
        throw err;
      });
      const p = new KeychainProvider({ platform: "darwin" });
      expect(await p.getSecret("absent")).toBeNull();
    });

    it("throws wrapped error on other failures", async () => {
      const err = new Error("denied") as Error & {
        status?: number;
        stderr?: string;
      };
      err.status = 50;
      err.stderr = "permission denied";
      execMock.mockImplementationOnce(() => {
        throw err;
      });
      const p = new KeychainProvider({ platform: "darwin" });
      await expect(p.getSecret("x")).rejects.toThrow(
        /security failed \(status=50\): permission denied/,
      );
    });
  });

  describe("Linux", () => {
    it("reads via `secret-tool lookup name <name>`", async () => {
      execMock.mockReturnValueOnce("linux-secret\n");
      const p = new KeychainProvider({ platform: "linux" });
      expect(await p.getSecret("MY_SECRET")).toBe("linux-secret");
      expect(execMock).toHaveBeenCalledWith(
        "secret-tool",
        ["lookup", "name", "MY_SECRET"],
        expect.any(Object),
      );
    });

    it("throws a helpful error when secret-tool is missing", async () => {
      const err = new Error("not found") as Error & { code?: string };
      err.code = "ENOENT";
      execMock.mockImplementationOnce(() => {
        throw err;
      });
      const p = new KeychainProvider({ platform: "linux" });
      await expect(p.getSecret("x")).rejects.toThrow(/libsecret/);
    });

    it("returns null when secret-tool exits 1 (miss)", async () => {
      const err = new Error("miss") as Error & { status?: number };
      err.status = 1;
      execMock.mockImplementationOnce(() => {
        throw err;
      });
      const p = new KeychainProvider({ platform: "linux" });
      expect(await p.getSecret("absent")).toBeNull();
    });
  });

  describe("Windows", () => {
    beforeEach(() => {
      keyringMocks.ctor.mockClear();
      keyringMocks.impl = null;
    });

    it("reads via new Entry(service, account).getPassword()", async () => {
      keyringMocks.impl = () => ({ getPassword: () => "windows-secret" });
      const p = new KeychainProvider({ platform: "win32" });
      expect(await p.getSecret("MY_SECRET")).toBe("windows-secret");
      expect(keyringMocks.ctor).toHaveBeenCalledWith("MY_SECRET", "default");
    });

    it("passes account through from options, defaults to 'default'", async () => {
      keyringMocks.impl = () => ({ getPassword: () => "v" });
      const p = new KeychainProvider({ platform: "win32", account: "alice" });
      await p.getSecret("SECRET");
      expect(keyringMocks.ctor).toHaveBeenCalledWith("SECRET", "alice");
    });

    it("applies servicePrefix to the Entry service arg", async () => {
      keyringMocks.impl = () => ({ getPassword: () => "v" });
      const p = new KeychainProvider({
        platform: "win32",
        servicePrefix: "com.example.myapp",
      });
      await p.getSecret("github");
      expect(keyringMocks.ctor).toHaveBeenCalledWith(
        "com.example.myapp.github",
        "default",
      );
    });

    it("returns null when getPassword returns null", async () => {
      keyringMocks.impl = () => ({ getPassword: () => null });
      const p = new KeychainProvider({ platform: "win32" });
      expect(await p.getSecret("absent")).toBeNull();
    });

    it("returns null when getPassword throws a 'not found' error", async () => {
      keyringMocks.impl = () => ({
        getPassword: () => {
          throw new Error("No matching entry found in secure storage");
        },
      });
      const p = new KeychainProvider({ platform: "win32" });
      expect(await p.getSecret("absent")).toBeNull();
    });

    it("wraps other errors with context", async () => {
      keyringMocks.impl = () => ({
        getPassword: () => {
          throw new Error("access denied by policy");
        },
      });
      const p = new KeychainProvider({ platform: "win32" });
      await expect(p.getSecret("x")).rejects.toThrow(
        /keychain provider on Windows: access denied by policy/,
      );
    });

    it("throws install hint when @napi-rs/keyring is not installed", async () => {
      // Un-mock and re-import so the dynamic `import("@napi-rs/keyring")`
      // inside keychain.ts hits the real Node resolver. `@napi-rs/keyring`
      // is NOT in devDependencies (it's an optional peer), so the resolver
      // will raise ERR_MODULE_NOT_FOUND — exactly the runtime condition
      // we want to exercise in `_loadOptional`.
      vi.resetModules();
      vi.doUnmock("@napi-rs/keyring");
      const { KeychainProvider: Fresh } = await import(
        "../../src/credentials/keychain.js"
      );
      const p = new Fresh({ platform: "win32" });
      await expect(p.getSecret("x")).rejects.toThrow(
        /npm install --save-dev @napi-rs\/keyring/,
      );
    });
  });

  describe("unsupported platforms", () => {
    it("throws on other platforms", async () => {
      const p = new KeychainProvider({ platform: "aix" });
      await expect(p.getSecret("x")).rejects.toThrow(/aix/);
    });
  });

  describe("describeSecret", () => {
    it("reports exists=true for present keys", async () => {
      execMock.mockReturnValueOnce("v\n");
      const p = new KeychainProvider({ platform: "darwin" });
      expect(await p.describeSecret("present")).toEqual({
        exists: true,
        provider: "keychain",
      });
    });

    it("reports exists=false for absent keys", async () => {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 44;
      execMock.mockImplementationOnce(() => {
        throw err;
      });
      const p = new KeychainProvider({ platform: "darwin" });
      expect(await p.describeSecret("absent")).toEqual({
        exists: false,
        provider: "keychain",
      });
    });
  });
});
