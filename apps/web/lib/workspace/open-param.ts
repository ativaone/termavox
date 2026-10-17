/**
 * The `/workspace?open=<sessionId>` contract (plan D-27): a page that just started a session
 * sends the browser here to show it. The id is honoured only when it names one of the user's own
 * sessions; otherwise the parameter is simply dropped. Either way the URL is cleaned without a
 * history entry, so Back never returns to a stale `?open=`.
 */
export interface OpenParam {
  /** The session to show, or null when the parameter is absent or names no session of the user. */
  sessionId: string | null;
  /** Whether the URL carried the parameter at all (and must be cleaned). */
  present: boolean;
}

export function resolveOpenParam(
  search: string | URLSearchParams | null | undefined,
  sessionIds: Iterable<string>,
): OpenParam {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? '');
  const raw = params.get('open');
  if (raw === null) return { sessionId: null, present: false };
  const id = raw.trim();
  if (!id) return { sessionId: null, present: true };
  for (const candidate of sessionIds) {
    if (candidate === id) return { sessionId: id, present: true };
  }
  return { sessionId: null, present: true };
}
