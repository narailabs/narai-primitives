/**
 * Bridges GcpClient's `{ok: false, code, ...}` result shape to the
 * handler-throws-an-Error contract the factory expects.
 */
export class GcpCliError extends Error {
  readonly code: string;
  readonly retriable: boolean;

  constructor(code: string, message: string, retriable: boolean) {
    super(message);
    this.name = "GcpCliError";
    this.code = code;
    this.retriable = retriable;
  }
}
