/**
 * Bridges JiraClient's `{ok: false, code, ...}` result shape to the
 * handler-throws-an-Error contract the factory expects.
 */
export class JiraError extends Error {
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
    this.name = "JiraError";
    this.code = code;
    this.retriable = retriable;
    this.httpStatus = httpStatus;
  }
}
