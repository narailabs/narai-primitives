/**
 * Bridges an HTTP/SDK client's `{ok: false, code, ...}` result shape to the
 * handler-throws-an-Error contract expected by `createConnector`. One class
 * replaces the per-connector error classes that all had the same shape.
 */
export class ConnectorError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    code: string,
    message: string,
    retriable: boolean,
    httpStatus?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retriable = retriable;
    this.httpStatus = httpStatus;
  }
}
