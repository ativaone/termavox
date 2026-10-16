import { isAPIError } from 'better-auth/api';

/** What a form needs from a Better Auth APIError: status, machine code, lockout wait. */
export interface AuthErrorInfo {
  status: number;
  code: string | undefined;
  retryAfterS: number | undefined;
}

/** Returns null for anything that is not a Better Auth APIError (callers rethrow those). */
export function authErrorInfo(err: unknown): AuthErrorInfo | null {
  if (!isAPIError(err)) return null;
  const body = (err.body ?? {}) as { code?: unknown; retryAfter?: unknown };
  return {
    status: err.statusCode,
    code: typeof body.code === 'string' ? body.code : undefined,
    retryAfterS: typeof body.retryAfter === 'number' ? body.retryAfter : undefined,
  };
}
