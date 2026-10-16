import { isInternalApiError } from '../internal-api.ts';

/**
 * How a failed internal API call reads to the user: one key under `manage.service` per class of
 * failure. Callers handle the cases that mean something specific to them (404, 409) first.
 */
export type ServiceErrorKey =
  | 'unavailable'
  | 'timeout'
  | 'notFound'
  | 'conflict'
  | 'forbidden'
  | 'limit'
  | 'rejected'
  | 'generic';

export function serviceErrorKey(err: unknown): ServiceErrorKey {
  if (!isInternalApiError(err)) return 'generic';
  switch (err.kind) {
    case 'unavailable':
      return 'unavailable';
    case 'timeout':
      return 'timeout';
    case 'not_found':
      return 'notFound';
    case 'conflict':
      return 'conflict';
    case 'forbidden':
      return 'forbidden';
    case 'rate_limited':
      return 'limit';
    case 'bad_request':
      return 'rejected';
    default:
      return 'generic';
  }
}
