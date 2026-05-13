/**
 * teams_error.ts — Microsoft Graph error envelope for the Teams connector.
 *
 * Mirrors the lightweight `ConnectorError` shape from the toolkit but
 * carries the Graph-specific `code` string (e.g. `InvalidAuthenticationToken`,
 * `itemNotFound`, `TooManyRequests`) alongside the HTTP status. The factory's
 * `mapError` translates the Graph code (then the HTTP status) into a canonical
 * toolkit `ErrorCode`.
 */
import { ConnectorError } from "narai-primitives/toolkit";

/**
 * TeamsError is a `ConnectorError` whose `code` field is a Microsoft Graph
 * error code (string). The connector factory's `mapError` translates that
 * string into a canonical toolkit `ErrorCode`. The class itself is
 * effectively a typed alias so callers can write `throw new TeamsError(...)`
 * without dragging the longer `ConnectorError` import everywhere.
 */
export class TeamsError extends ConnectorError {
  constructor(
    code: string,
    message: string,
    retriable: boolean,
    httpStatus?: number,
  ) {
    super(code, message, retriable, httpStatus);
    this.name = "TeamsError";
  }
}
