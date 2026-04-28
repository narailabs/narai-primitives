/**
 * Bridges GithubClient's `{ok: false, code, ...}` result shape to the
 * handler-throws-an-Error contract the factory expects.
 */
export class GithubError extends Error {
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
    this.name = "GithubError";
    this.code = code;
    this.retriable = retriable;
    this.httpStatus = httpStatus;
  }
}
