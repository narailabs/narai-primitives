/**
 * fetch_helper — shared HTTP fetch wrapper with size + timeout caps.
 *
 * Behaviour:
 *   - `AbortController` enforces the timeout. On overrun, the returned
 *     promise rejects with the underlying `AbortError`.
 *   - Body size is enforced by streaming the response and counting
 *     bytes. If `content-length` is present and already exceeds the
 *     cap, we short-circuit before reading. Otherwise we read chunks;
 *     once the running total exceeds `maxBytes`, we abort and throw
 *     `FetchCapExceeded`.
 *   - Consumers receive a plain `Response` whose `body` has been
 *     replaced by a `ReadableStream` that reads from an in-memory
 *     buffer; calling `.text()` or `.arrayBuffer()` on that Response
 *     returns exactly the (capped) bytes.
 */

export const FETCH_MAX_BYTES_DEFAULT = 50 * 1024 * 1024; // 50 MB
export const FETCH_TIMEOUT_MS_DEFAULT = 60_000; // 60 s

/** Options controlling the caps. Missing fields fall back to defaults. */
export interface FetchCapsOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Optional external signal composed with the internal timeout. */
  signal?: AbortSignal;
}

/** Thrown when the response body grows past `maxBytes`. */
export class FetchCapExceeded extends Error {
  readonly capBytes: number;
  readonly observedBytes: number;
  constructor(capBytes: number, observedBytes: number, url: string) {
    super(
      `fetch_helper: response body exceeded cap of ${capBytes} bytes ` +
        `(observed ${observedBytes} while fetching ${url})`,
    );
    this.name = "FetchCapExceeded";
    this.capBytes = capBytes;
    this.observedBytes = observedBytes;
  }
}

function mergeSignals(
  internal: AbortSignal,
  external: AbortSignal | undefined,
): AbortSignal {
  if (external === undefined) return internal;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn([internal, external]);
  }
  const controller = new AbortController();
  const onAbort = (reason: unknown): void => {
    controller.abort(reason);
  };
  if (internal.aborted) controller.abort(internal.reason);
  else internal.addEventListener("abort", () => onAbort(internal.reason), { once: true });
  if (external.aborted) controller.abort(external.reason);
  else external.addEventListener("abort", () => onAbort(external.reason), { once: true });
  return controller.signal;
}

/**
 * Perform a cap-limited fetch. The returned Response is safe to treat
 * as a normal `Response`; its body has already been read into memory
 * (bounded by `maxBytes`), and the Response is rebuilt around that
 * buffer so downstream `.text()` / `.json()` / `.arrayBuffer()` calls
 * work without re-hitting the network.
 *
 * Throws:
 *   - `FetchCapExceeded` when `content-length` or streamed bytes
 *     exceed `maxBytes`.
 *   - `DOMException` / `AbortError` when the timeout fires or an
 *     external signal is aborted.
 *   - Any other error thrown by `fetch` itself (network, DNS, etc.).
 */
export async function fetchWithCaps(
  url: string,
  init: RequestInit = {},
  caps: FetchCapsOptions = {},
): Promise<Response> {
  const maxBytes = caps.maxBytes ?? FETCH_MAX_BYTES_DEFAULT;
  const timeoutMs = caps.timeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(new Error("fetch_helper timeout")), timeoutMs);
  const signal = mergeSignals(timeoutCtl.signal, caps.signal ?? init.signal ?? undefined);

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }

  const clHeader = response.headers.get("content-length");
  if (clHeader !== null) {
    const cl = Number(clHeader);
    if (Number.isFinite(cl) && cl > maxBytes) {
      try { await response.body?.cancel(); } catch { /* best-effort */ }
      throw new FetchCapExceeded(maxBytes, cl, url);
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    return response;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* best-effort */ }
      throw new FetchCapExceeded(maxBytes, total, url);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Response(merged, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
