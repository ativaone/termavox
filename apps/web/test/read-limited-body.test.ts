import { describe, expect, it, vi } from 'vitest';
import { readLimitedBody } from '../lib/read-limited-body.ts';

const URL_ = 'https://termavox.test/';

function streaming(chunks: Uint8Array[], cancel = vi.fn()) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
  return {
    pulled: () => i,
    request: new Request(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit),
  };
}

describe('readLimitedBody', () => {
  it('reads a body up to exactly the maximum', async () => {
    const request = new Request(URL_, { method: 'POST', body: 'héllo' });
    await expect(readLimitedBody(request, 6)).resolves.toBe('héllo');
  });

  it('reads no body as an empty text', async () => {
    await expect(readLimitedBody(new Request(URL_), 10)).resolves.toBe('');
  });

  it('decodes a character split across chunks', async () => {
    const bytes = new TextEncoder().encode('é');
    const { request } = streaming([bytes.slice(0, 1), bytes.slice(1)]);
    await expect(readLimitedBody(request, 10)).resolves.toBe('é');
  });

  it('refuses a stream with no Content-Length past the maximum, cancelling it there', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(4);
    const { request, pulled } = streaming(
      Array.from({ length: 100 }, () => chunk),
      cancel,
    );
    await expect(readLimitedBody(request, 10)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulled()).toBeLessThan(10);
  });

  it('refuses a declared size over the maximum without reading the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request(URL_, {
      method: 'POST',
      headers: { 'content-length': '11' },
      body,
      duplex: 'half',
    } as RequestInit);
    await expect(readLimitedBody(request, 10)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not trust a small declared size', async () => {
    const chunk = new Uint8Array(8);
    const { request: base } = streaming([chunk, chunk]);
    const headers = new Headers({ 'content-length': '1' });
    const request = new Request(base, { headers });
    await expect(readLimitedBody(request, 10)).resolves.toBeNull();
  });
});
