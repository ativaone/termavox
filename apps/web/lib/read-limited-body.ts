import './server-guard.ts';

/**
 * A request's body as text, read with a running byte count, so a body with no (or a false)
 * Content-Length is never buffered past `maxBytes`. Null when it is too large: a declared size
 * over the maximum is refused unread, and a stream that passes it is cancelled there.
 */
export async function readLimitedBody(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) {
    await body?.cancel().catch(() => {});
    return null;
  }
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}
