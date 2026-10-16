import { Notice } from '../ui/notice.tsx';

/**
 * The success slip after a Server Action redirected with `?done=<key>`. Only keys the page lists
 * are shown, so the query string can never inject text.
 */
export function DoneNotice({
  done,
  messages,
}: {
  done: string | string[] | undefined;
  messages: Record<string, string>;
}) {
  const key = typeof done === 'string' ? done : undefined;
  const message = key && Object.hasOwn(messages, key) ? messages[key] : undefined;
  if (!message) return null;
  return <Notice tone="success">{message}</Notice>;
}

/** Reads one string search param. */
export function param(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
