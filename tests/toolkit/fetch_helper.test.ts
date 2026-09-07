/**
 * Tests for fetch_helper — size + timeout caps on outgoing HTTP.
 *
 * We mock `globalThis.fetch` rather than standing up a real server so the
 * suite stays deterministic and offline-safe.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  FETCH_MAX_BYTES_DEFAULT,
  FETCH_TIMEOUT_MS_DEFAULT,
  FetchCapExceeded,
  fetchWithCaps,
} from "../../src/toolkit/fetch_helper.js";

describe("defaults", () => {
  it("uses 50 MB and 60 s by default", () => {
    expect(FETCH_MAX_BYTES_DEFAULT).toBe(50 * 1024 * 1024);
    expect(FETCH_TIMEOUT_MS_DEFAULT).toBe(60_000);
  });
});

describe("fetchWithCaps", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchWithBody(body: Uint8Array, headers: Record<string, string> = {}): void {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason ?? new Error("aborted");
      }
      return new Response(body, { status: 200, headers });
    }) as unknown as typeof globalThis.fetch;
  }

  /** Mock whose promise only settles when the composed signal aborts. */
  function mockFetchAwaitsAbort(): void {
    globalThis.fetch = vi.fn((_: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason ?? new Error("aborted"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    }) as unknown as typeof globalThis.fetch;
  }

  it("returns the response body when it fits under the cap", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    mockFetchWithBody(body);
    const res = await fetchWithCaps("https://example.com/tiny", {}, { maxBytes: 16 });
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });

  it("throws FetchCapExceeded with populated fields when content-length exceeds the cap", async () => {
    const body = new Uint8Array(256);
    mockFetchWithBody(body, { "content-length": "10485760" });
    await expect(
      fetchWithCaps("https://example.com/big", {}, { maxBytes: 100 }),
    ).rejects.toMatchObject({
      name: "FetchCapExceeded",
      capBytes: 100,
      observedBytes: 10485760,
    });
  });

  it("throws FetchCapExceeded with populated fields when streamed bytes exceed the cap", async () => {
    const body = new Uint8Array(2048);
    mockFetchWithBody(body);
    let caught: unknown;
    try {
      await fetchWithCaps("https://example.com/stream", {}, { maxBytes: 512 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FetchCapExceeded);
    const err = caught as FetchCapExceeded;
    expect(err.capBytes).toBe(512);
    expect(err.observedBytes).toBeGreaterThan(512);
    expect(err.message).toContain("exceeded cap of 512");
  });

  it("aborts when the timeout fires before fetch settles", async () => {
    mockFetchAwaitsAbort();
    await expect(
      fetchWithCaps("https://example.com/slow", {}, { timeoutMs: 10 }),
    ).rejects.toThrow();
  });

  it("composes an external AbortSignal with the internal timeout", async () => {
    mockFetchAwaitsAbort();
    const ctl = new AbortController();
    const p = fetchWithCaps("https://example.com/slow", {}, {
      timeoutMs: 60_000,
      signal: ctl.signal,
    });
    ctl.abort(new Error("caller cancelled"));
    await expect(p).rejects.toThrow();
  });

  it("rejects when the external signal is already aborted before the call", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error("pre-aborted"));
    mockFetchAwaitsAbort();
    await expect(
      fetchWithCaps("https://example.com/any", {}, { signal: ctl.signal }),
    ).rejects.toThrow();
  });

  it("composes signals via the fallback path when AbortSignal.any is unavailable", async () => {
    // Simulate an older runtime where AbortSignal.any does not exist, so
    // mergeSignals must exercise its manual AbortController fallback.
    const abortSignal = AbortSignal as unknown as { any?: unknown };
    const origAny = abortSignal.any;
    try {
      abortSignal.any = undefined;
      mockFetchAwaitsAbort();
      const ctl = new AbortController();
      const p = fetchWithCaps("https://example.com/slow", {}, {
        timeoutMs: 60_000,
        signal: ctl.signal,
      });
      ctl.abort(new Error("caller cancelled via fallback"));
      await expect(p).rejects.toThrow();
    } finally {
      abortSignal.any = origAny;
    }
  });

  it("works on responses with no body (HEAD-like)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 204 }),
    ) as unknown as typeof globalThis.fetch;
    const res = await fetchWithCaps("https://example.com/nobody");
    expect(res.status).toBe(204);
  });
});
