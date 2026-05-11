/**
 * http_client.ts — shared HTTP client used by every HTTP-based connector.
 *
 * Replaces the near-identical retry/throttle/timeout/auth machinery that
 * previously lived in each connector's lib/<name>_client.ts. Connectors
 * pass in their auth header and any service-specific defaults; the
 * client handles the rest:
 *
 * - GET/POST/PUT/DELETE/PATCH allow-list (default GET-only)
 * - URL validation via `validateUrl`
 * - Per-client rate limit (60 req/min default)
 * - Connect + read timeouts via AbortController (10s / 30s default)
 * - 429/5xx retry with `Retry-After` honoured + exponential backoff
 * - Test injection (`fetchImpl`, `sleepImpl`)
 * - JSON / binary / text response handling
 * - Custom retry signal (`shouldRetryResponse`) for service-specific
 *   quirks like GitHub's `x-ratelimit-remaining=0` on a 403.
 *
 * GraphQL connectors layer their own `{data, errors}` unwrapping on top
 * of `request("POST", "/graphql", { body: { query, variables } })`. The
 * client itself remains protocol-agnostic.
 */

import { validateUrl } from "./security_check.js";
import { ConnectorError } from "./connector_error.js";
import type { ErrorCode } from "./policy/types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface HttpResultOk<T> {
  ok: true;
  data: T;
  status: number;
}

export interface HttpResultErr {
  ok: false;
  code: string;
  message: string;
  retriable: boolean;
  status?: number;
}

export type HttpResult<T> = HttpResultOk<T> | HttpResultErr;

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export type ResponseType = "json" | "binary" | "text";

export interface HttpRequestOptions {
  query?:
    | Record<string, string | number | boolean | null | undefined>
    | undefined;
  body?: unknown | undefined;
  headers?: Record<string, string> | undefined;
  responseType?: ResponseType | undefined;
  /**
   * For `responseType: "binary"`, the filename to use when the response
   * has no Content-Disposition header. If omitted, falls back to the
   * last path segment of the URL (or "download").
   */
  filenameFallback?: string | undefined;
}

export interface HttpClientOptions {
  /** Absolute URL — relative paths in `request()` are joined to this. */
  baseUrl: string;
  /** Pre-formatted Authorization header value (e.g. `Bearer abc`, `Basic ...`). */
  authHeader: string;
  /** Used in error messages (e.g. "GitHub rate limit hit"). */
  serviceName: string;
  /** Allowed HTTP methods. Default: `["GET"]`. */
  allowedMethods?: ReadonlySet<HttpMethod> | undefined;
  /** Headers attached to every request (e.g. `Notion-Version`, custom `Accept`). */
  defaultHeaders?: Record<string, string> | undefined;
  rateLimitPerMin?: number | undefined;
  connectTimeoutMs?: number | undefined;
  readTimeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Service-specific retry signal. Return `true` for non-429/non-5xx
   * responses that should still trigger the retry loop. Example: GitHub's
   * 403 with `x-ratelimit-remaining: 0` is a rate-limit in disguise.
   */
  shouldRetryResponse?: ((response: Response) => boolean) | undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_PER_MIN = 60;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_ALLOWED_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  "GET",
]);

export function classifyHttpStatus(status: number): string {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "UNPROCESSABLE";
  if (status === 400) return "BAD_REQUEST";
  return "HTTP_ERROR";
}

/**
 * Default mapping from `HttpClient` `result.code` values to canonical
 * `ErrorCode`s used by `createConnector`. Each connector typically
 * spreads this and overrides a few connector-specific keys.
 */
export const DEFAULT_HTTP_CODE_MAP: Record<string, string> = {
  UNAUTHORIZED: "AUTH_ERROR",
  FORBIDDEN: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "CONNECTION_ERROR",
  SERVER_ERROR: "CONNECTION_ERROR",
  BAD_REQUEST: "VALIDATION_ERROR",
  UNPROCESSABLE: "VALIDATION_ERROR",
  INVALID_URL: "VALIDATION_ERROR",
  METHOD_NOT_ALLOWED: "VALIDATION_ERROR",
  HTTP_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
};

export class HttpClient {
  private readonly _baseUrl: string;
  private readonly _authHeader: string;
  private readonly _serviceName: string;
  private readonly _allowedMethods: ReadonlySet<HttpMethod>;
  private readonly _defaultHeaders: Record<string, string>;
  private readonly _rateLimitPerMin: number;
  private readonly _connectTimeoutMs: number;
  private readonly _readTimeoutMs: number;
  private readonly _maxAttempts: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _shouldRetryResponse: ((r: Response) => boolean) | undefined;
  private _requestTimestamps: number[] = [];

  constructor(opts: HttpClientOptions) {
    if (!validateUrl(opts.baseUrl)) {
      throw new Error(`Invalid base URL: ${opts.baseUrl}`);
    }
    this._baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this._authHeader = opts.authHeader;
    this._serviceName = opts.serviceName;
    this._allowedMethods = opts.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
    this._defaultHeaders = opts.defaultHeaders ?? {};
    this._rateLimitPerMin = opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this._maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._sleep =
      opts.sleepImpl ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this._shouldRetryResponse = opts.shouldRetryResponse;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  get host(): string {
    return new URL(this._baseUrl).host;
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: HttpRequestOptions = {},
  ): Promise<HttpResult<T>> {
    if (!this._allowedMethods.has(method)) {
      return {
        ok: false,
        code: "METHOD_NOT_ALLOWED",
        message: `Method ${method} not allowed`,
        retriable: false,
      };
    }
    const url = this._buildUrl(path, opts.query);
    if (!validateUrl(url)) {
      return {
        ok: false,
        code: "INVALID_URL",
        message: `URL rejected: ${url}`,
        retriable: false,
      };
    }

    const responseType: ResponseType = opts.responseType ?? "json";

    let lastError: HttpResultErr | null = null;
    for (let attempt = 0; attempt < this._maxAttempts; attempt++) {
      await this._throttle();
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        this._connectTimeoutMs + this._readTimeoutMs,
      );
      try {
        const headers = this._buildHeaders(opts, responseType);
        // Pass FormData / Blob / ArrayBuffer / typed-array / string bodies
        // through unchanged; fetch handles their encoding (and for FormData
        // sets the multipart boundary, which is why we leave Content-Type
        // off in that case — see _buildHeaders).
        const hasBody = opts.body !== undefined && opts.body !== null;
        const init: RequestInit = hasBody
          ? {
              method,
              headers,
              signal: ctrl.signal,
              body: isRawBody(opts.body)
                ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (opts.body as any)
                : JSON.stringify(opts.body),
            }
          : { method, headers, signal: ctrl.signal };

        const response = await this._fetch(url, init);
        const status = response.status;
        const customRetry = this._shouldRetryResponse?.(response) ?? false;

        if (status === 429 || customRetry) {
          const retryAfter = parseRetryAfter(
            response.headers.get("retry-after"),
          );
          lastError = {
            ok: false,
            code: "RATE_LIMITED",
            message: `${this._serviceName} rate limit hit`,
            retriable: true,
            status,
          };
          if (attempt < this._maxAttempts - 1) {
            await this._sleep(
              retryAfter ?? Math.min(30_000, 500 * 2 ** attempt),
            );
            continue;
          }
          return lastError;
        }

        if (status >= 500) {
          const retryAfter = parseRetryAfter(
            response.headers.get("retry-after"),
          );
          lastError = {
            ok: false,
            code: "SERVER_ERROR",
            message: `${this._serviceName} returned HTTP ${status}`,
            retriable: true,
            status,
          };
          if (attempt < this._maxAttempts - 1) {
            await this._sleep(
              retryAfter ?? Math.min(30_000, 500 * 2 ** attempt),
            );
            continue;
          }
          return lastError;
        }

        if (!response.ok) {
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            /* ignore */
          }
          return {
            ok: false,
            code: classifyHttpStatus(status),
            message: `${this._serviceName} HTTP ${status}: ${truncate(bodyText, 200)}`,
            retriable: false,
            status,
          };
        }

        if (status === 204) {
          return { ok: true, data: {} as T, status };
        }

        if (responseType === "binary") {
          const buf = await response.arrayBuffer();
          const cdName = parseContentDispositionFilename(
            response.headers.get("content-disposition"),
          );
          const data: BinaryResponse = {
            bytes: new Uint8Array(buf),
            contentType:
              response.headers.get("content-type") ??
              "application/octet-stream",
            filename:
              cdName ?? opts.filenameFallback ?? filenameFromPath(path),
          };
          return { ok: true, data: data as unknown as T, status };
        }
        if (responseType === "text") {
          const data = (await response.text()) as unknown as T;
          return { ok: true, data, status };
        }
        const data = (await response.json()) as T;
        return { ok: true, data, status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted =
          err instanceof DOMException || /abort/i.test(message);
        lastError = {
          ok: false,
          code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
          message: aborted ? "Request timed out" : message,
          retriable: true,
        };
        if (attempt < this._maxAttempts - 1) {
          await this._sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        return lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    return (
      lastError ?? {
        ok: false,
        code: "UNKNOWN",
        message: "Exhausted retries without a response",
        retriable: true,
      }
    );
  }

  /** Clear the per-client rate-limit sliding window. Test-only convenience. */
  resetRateLimiter(): void {
    this._requestTimestamps = [];
  }

  private async _throttle(): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    this._requestTimestamps = this._requestTimestamps.filter((t) => t > cutoff);
    if (this._requestTimestamps.length >= this._rateLimitPerMin) {
      const oldest = this._requestTimestamps[0] ?? now;
      const waitMs = Math.max(0, 60_000 - (now - oldest));
      if (waitMs > 0) await this._sleep(waitMs);
      this._requestTimestamps = this._requestTimestamps.filter(
        (t) => t > Date.now() - 60_000,
      );
    }
    this._requestTimestamps.push(Date.now());
  }

  private _buildUrl(
    path: string,
    query?: HttpRequestOptions["query"],
  ): string {
    const isAbsolute = /^[a-z][a-z0-9+.\-]*:\/\//i.test(path);
    const url = isAbsolute
      ? path
      : `${this._baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
  }

  private _buildHeaders(
    opts: HttpRequestOptions,
    responseType: ResponseType,
  ): Record<string, string> {
    const accept =
      responseType === "binary"
        ? "*/*"
        : responseType === "text"
          ? "text/plain"
          : "application/json";
    const headers: Record<string, string> = {
      Authorization: this._authHeader,
      Accept: accept,
      ...this._defaultHeaders,
      ...(opts.headers ?? {}),
    };
    const hasBody = opts.body !== undefined && opts.body !== null;
    const headerHasCT =
      "Content-Type" in headers || "content-type" in headers;
    // Only inject Content-Type for serialized JSON bodies. FormData/Blob/
    // ArrayBuffer / typed-array bodies need fetch to set their own
    // Content-Type (multipart boundary, binary mime, etc.).
    if (hasBody && !headerHasCT && !isRawBody(opts.body)) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }
}

function isRawBody(body: unknown): boolean {
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer) return true;
  if (body instanceof Uint8Array) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (
    typeof URLSearchParams !== "undefined" &&
    body instanceof URLSearchParams
  ) {
    return true;
  }
  return false;
}

// ─── Helpers (internal but stable enough to export for tests) ────────────

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // Reject negative numeric values explicitly so they don't fall through
  // into Date.parse (which would interpret "-5" as year 5 BC and emit 0).
  if (Number.isFinite(seconds) && seconds < 0) return null;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function parseContentDispositionFilename(
  header: string | null,
): string | null {
  if (!header) return null;
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1] ?? null;
}

export function filenameFromPath(path: string): string {
  const clean = path.split("?")[0] ?? path;
  const segments = clean.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "download";
}

/**
 * Convert a `HttpResult.ok=false` into a thrown `ConnectorError` so action
 * handlers can keep using the throw-on-error contract that `createConnector`
 * expects. Eliminates the per-connector `throwIfError` helpers.
 */
export function throwIfHttpError<T>(
  result: HttpResult<T>,
): asserts result is Extract<HttpResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new ConnectorError(
      result.code,
      result.message,
      result.retriable,
      result.status,
    );
  }
}

/**
 * Build a `mapError` function suitable for passing to `createConnector`'s
 * options. Translates `ConnectorError.code` through the supplied code map
 * into a canonical `ErrorCode` envelope. Eliminates the per-connector
 * `mapError: (err) => { if (err instanceof XxxError) ... }` boilerplate.
 */
export function mapHttpError(
  codeMap: Record<string, ErrorCode>,
  defaultCode: ErrorCode = "CONNECTION_ERROR",
): (
  err: unknown,
) =>
  | { error_code: ErrorCode; message: string; retriable: boolean }
  | undefined {
  return (err) => {
    if (err instanceof ConnectorError) {
      return {
        error_code: codeMap[err.code] ?? defaultCode,
        message: err.message,
        retriable: err.retriable,
      };
    }
    return undefined;
  };
}
