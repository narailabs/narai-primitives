/**
 * Bridges LinearClient's `{ok: false, code, ...}` result shape to the
 * handler-throws-an-Error contract the factory expects.
 */
export class LinearError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status: number | undefined;

  constructor(
    code: string,
    message: string,
    retriable: boolean,
    status?: number,
  ) {
    super(message);
    this.name = "LinearError";
    this.code = code;
    this.retriable = retriable;
    this.status = status;
  }
}
