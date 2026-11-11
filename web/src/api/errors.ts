// Errors from the local API. The server answers a non-2xx status with
// {"error": "..."}; ApiError keeps that message so the UI can show it as is.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The token was refused: Portplane restarted, so this page holds a stale token. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err) || "Something went wrong";
}
