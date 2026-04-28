/**
 * Error class bridging the ConfluenceClient's `{ok: false, code, ...}` result
 * shape into the handler-throws-an-Error contract that `createConnector`
 * expects. The factory's `mapError` hook unwraps these back into a proper
 * error envelope with the canonical toolkit error codes.
 */
export class ConfluenceError extends Error {
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
    this.name = "ConfluenceError";
    this.code = code;
    this.retriable = retriable;
    this.httpStatus = httpStatus;
  }
}
