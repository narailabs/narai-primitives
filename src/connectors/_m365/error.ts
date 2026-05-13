/**
 * _m365/error.ts — Microsoft Graph error envelope shared by the
 * teams-connector and outlook-connector.
 *
 * Mirrors the lightweight `ConnectorError` shape from the toolkit but
 * carries the Graph-specific `code` string (e.g. `InvalidAuthenticationToken`,
 * `itemNotFound`, `TooManyRequests`) alongside the HTTP status. The factory's
 * `mapError` translates the Graph code (then the HTTP status) into a canonical
 * toolkit `ErrorCode`.
 */
import {
  ConnectorError,
  type ErrorCode,
  type ErrorEnvelope,
} from "narai-primitives/toolkit";

/**
 * M365Error is a `ConnectorError` whose `code` field is a Microsoft Graph
 * error code (string). The connector factory's `mapError` translates that
 * string into a canonical toolkit `ErrorCode`. The class itself is
 * effectively a typed alias so callers can write `throw new M365Error(...)`
 * without dragging the longer `ConnectorError` import everywhere.
 */
export class M365Error extends ConnectorError {
  constructor(
    code: string,
    message: string,
    retriable: boolean,
    httpStatus?: number,
  ) {
    super(code, message, retriable, httpStatus);
    this.name = "M365Error";
  }
}

/**
 * Union of the Graph error-code translations previously inlined inside
 * teams/index.ts and outlook/index.ts. The two maps were nearly identical;
 * the merged set adds the Outlook-specific Exchange-flavored codes
 * (`ErrorAccessDenied`, `ErrorItemNotFound`, `ApplicationThrottled`,
 * `ErrorInvalidIdMalformed`) and is safe to share — every entry maps to a
 * canonical toolkit `ErrorCode` valid for both connectors.
 */
export const M365_CODE_MAP: Record<string, ErrorCode> = {
  // Authentication / authorization
  InvalidAuthenticationToken: "AUTH_ERROR",
  UnauthenticatedRequest: "AUTH_ERROR",
  Authorization_IdentityNotFound: "AUTH_ERROR",
  Forbidden: "AUTH_ERROR",
  AccessDenied: "AUTH_ERROR",
  ErrorAccessDenied: "AUTH_ERROR",
  Authorization_RequestDenied: "AUTH_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  // Not found
  NotFound: "NOT_FOUND",
  itemNotFound: "NOT_FOUND",
  ErrorItemNotFound: "NOT_FOUND",
  Request_ResourceNotFound: "NOT_FOUND",
  ResourceNotFound: "NOT_FOUND",
  // Rate-limit
  TooManyRequests: "RATE_LIMITED",
  activityLimitReached: "RATE_LIMITED",
  ApplicationThrottled: "RATE_LIMITED",
  // Validation
  BadRequest: "VALIDATION_ERROR",
  invalidRequest: "VALIDATION_ERROR",
  Request_BadRequest: "VALIDATION_ERROR",
  ErrorInvalidIdMalformed: "VALIDATION_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  // 5xx / availability
  ServiceNotAvailable: "CONNECTION_ERROR",
  ServiceUnavailable: "CONNECTION_ERROR",
  InternalServerError: "CONNECTION_ERROR",
  generalException: "CONNECTION_ERROR",
  UnknownError: "CONNECTION_ERROR",
  NetworkError: "CONNECTION_ERROR",
  // Timeout
  timeout: "TIMEOUT",
  Timeout: "TIMEOUT",
  gatewayTimeout: "TIMEOUT",
  // Config
  CONFIG_ERROR: "CONFIG_ERROR",
};

function mapByHttpStatus(status: number | undefined): ErrorCode {
  if (status === undefined) return "CONNECTION_ERROR";
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 404) return "NOT_FOUND";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  if (status >= 500) return "CONNECTION_ERROR";
  return "CONNECTION_ERROR";
}

const RETRIABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMITED",
  "TIMEOUT",
  "CONNECTION_ERROR",
]);

/**
 * Factory producing the `mapError` function the connector factory expects.
 * Mirrors the inline `customMapError` previously duplicated in
 * teams/index.ts and outlook/index.ts: handle `M365Error` (or
 * `ConnectorError`) instances by looking up `M365_CODE_MAP`, falling back to
 * status-code-based mapping.
 */
export function makeM365MapError(): (
  err: unknown,
  action: string,
) => Partial<ErrorEnvelope> | undefined {
  return function customMapError(
    err: unknown,
    _action: string,
  ): Partial<ErrorEnvelope> | undefined {
    if (err instanceof M365Error || err instanceof ConnectorError) {
      const mapped = M365_CODE_MAP[err.code] ?? mapByHttpStatus(err.httpStatus);
      return {
        error_code: mapped,
        message: err.message,
        retriable: err.retriable || RETRIABLE.has(mapped),
      };
    }
    return undefined;
  };
}
