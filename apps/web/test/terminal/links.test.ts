import { afterEach, describe, expect, it, vi } from 'vitest';
import { hyperlinkHandler, openLink } from '../../lib/terminal/links.ts';

const opened: Array<[string, string, string]> = [];
vi.stubGlobal('window', {
  open: (url: string, target: string, features: string) => {
    opened.push([url, target, features]);
    return null;
  },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  opened.length = 0;
});

describe('terminal link policy (L1)', () => {
  it('opens http(s) links only after the confirmation, without opener or referrer', async () => {
    const asked: string[] = [];
    const confirm = (uri: string) => {
      asked.push(uri);
      return uri.endsWith('/ok');
    };
    openLink('https://example.test/ok', confirm);
    openLink('https://example.test/no', confirm);
    await tick();
    expect(asked).toEqual(['https://example.test/ok', 'https://example.test/no']);
    expect(opened).toEqual([['https://example.test/ok', '_blank', 'noopener,noreferrer']]);
  });

  it('routes OSC 8 hyperlinks through the same policy and refuses other schemes', async () => {
    const asked: string[] = [];
    const handler = hyperlinkHandler(async (uri) => {
      asked.push(uri);
      return true;
    });
    expect(handler.allowNonHttpProtocols).toBe(false);
    const event = {} as MouseEvent;
    const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
    for (const uri of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      handler.activate(event, uri, range);
    }
    handler.activate(event, 'http://example.test/osc8', range);
    await tick();
    expect(asked).toEqual(['http://example.test/osc8']);
    expect(opened).toEqual([['http://example.test/osc8', '_blank', 'noopener,noreferrer']]);
  });

  it('confirms and opens the parsed URL: invisible characters encoded, IDN hosts in punycode', async () => {
    const asked: string[] = [];
    const confirm = (uri: string) => {
      asked.push(uri);
      return true;
    };
    // U+202E in the user info would show the rest reversed, as if it were the host.
    openLink('https://bank.example‮@evil.test/login', confirm);
    openLink('https://exаmple.test/', confirm); // Cyrillic а
    openLink('HTTPS://Example.TEST/café?q=​', confirm);
    await tick();
    expect(asked).toEqual([
      'https://bank.example%E2%80%AE@evil.test/login',
      'https://xn--exmple-4nf.test/',
      'https://example.test/caf%C3%A9?q=%E2%80%8B',
    ]);
    for (const uri of asked) expect(uri).toMatch(/^[!-~]+$/); // printable ASCII only
    expect(opened).toEqual(asked.map((uri) => [uri, '_blank', 'noopener,noreferrer']));
  });

  it('opens nothing for other schemes or text the URL parser refuses', async () => {
    const asked: string[] = [];
    const confirm = (uri: string) => {
      asked.push(uri);
      return true;
    };
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,x',
      'https://exa mple.test/',
      'https://evil‮.test/',
      'http://',
      'https://[::1',
      ' https://example.test/',
    ]) {
      openLink(uri, confirm);
    }
    await tick();
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('opens nothing without a confirmation callback', async () => {
    hyperlinkHandler(undefined).activate({} as MouseEvent, 'https://example.test', {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    });
    await tick();
    expect(opened).toEqual([]);
  });
});
