import { EMPTY_LAYOUT, type WorkspaceLayout } from '@termdock/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLayoutResponse, parseIfMatch, putLayoutResponse } from '../lib/layout-api.ts';
import { getLayout } from '../lib/repo/layouts.ts';
import {
  createUser,
  type Jar,
  makeRuntime,
  PUBLIC_URL,
  signIn,
  type TestRuntime,
} from './helpers.ts';

let t: TestRuntime;
let ann: { id: string; jar: Jar };
let ben: { id: string; jar: Jar };

const LAYOUT: WorkspaceLayout = {
  version: 1,
  activeTabId: 't1',
  tabs: [
    {
      id: 't1',
      activePaneId: 'p1',
      root: {
        type: 'split',
        id: 'a',
        direction: 'row',
        sizes: [60, 40],
        children: [
          { type: 'leaf', id: 'p1', sessionId: 's1' },
          { type: 'leaf', id: 'p2', sessionId: null },
        ],
      },
    },
  ],
};

beforeAll(async () => {
  t = makeRuntime();
  const a = await createUser(t.rt, 'ann');
  const b = await createUser(t.rt, 'ben');
  ann = { id: a.id, jar: (await signIn(t.rt, 'ann')).jar };
  ben = { id: b.id, jar: (await signIn(t.rt, 'ben')).jar };
});
afterAll(() => t.cleanup());

function get(jar?: Jar, extra: Record<string, string> = {}) {
  const headers = jar?.headers(extra) ?? new Headers(extra);
  return getLayoutResponse(t.rt, new Request(`${PUBLIC_URL}/api/layout`, { headers }));
}

function put(
  body: unknown,
  opts: { jar?: Jar; ifMatch?: string | null; origin?: string | null } = {},
) {
  const headers = opts.jar?.headers() ?? new Headers();
  headers.set('content-type', 'application/json');
  const origin = opts.origin === undefined ? PUBLIC_URL : opts.origin;
  if (origin) headers.set('origin', origin);
  if (opts.ifMatch !== null) headers.set('if-match', opts.ifMatch ?? '"0"');
  return putLayoutResponse(
    t.rt,
    new Request(`${PUBLIC_URL}/api/layout`, {
      method: 'PUT',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('GET/PUT /api/layout (plan §8.2)', () => {
  it('returns the empty layout at version 0 before the first save', async () => {
    const res = await get(ann.jar);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ layout: EMPTY_LAYOUT, version: 0 });
  });

  it('saves with If-Match and answers a stale version with 409 and the current version', async () => {
    const first = await put(LAYOUT, { jar: ann.jar, ifMatch: '"0"' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ version: 1 });

    const stale = await put(
      { ...LAYOUT, activeTabId: null, tabs: [] },
      { jar: ann.jar, ifMatch: '0' },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'CONFLICT', version: 1 });
    expect(getLayout(t.rt.db, ann.id)).toEqual({ layout: LAYOUT, version: 1 });

    const second = await put(EMPTY_LAYOUT, { jar: ann.jar, ifMatch: 'W/"1"' });
    expect(await second.json()).toEqual({ version: 2 });
    const reread = await get(ann.jar, { 'sec-fetch-site': 'same-origin' });
    expect(await reread.json()).toEqual({ layout: EMPTY_LAYOUT, version: 2 });
  });

  it('validates the layout, the If-Match header and the body size', async () => {
    expect((await put(LAYOUT, { jar: ann.jar, ifMatch: null })).status).toBe(428);
    expect((await put(LAYOUT, { jar: ann.jar, ifMatch: '*' })).status).toBe(428);
    expect((await put('{not json', { jar: ann.jar, ifMatch: '"2"' })).status).toBe(400);
    const badSizes = structuredClone(LAYOUT) as { tabs: Array<{ root: { sizes: number[] } }> };
    badSizes.tabs[0]!.root.sizes = [100];
    expect((await put(badSizes, { jar: ann.jar, ifMatch: '"2"' })).status).toBe(400);
    expect((await put({ ...LAYOUT, version: 2 }, { jar: ann.jar, ifMatch: '"2"' })).status).toBe(
      400,
    );
    const huge = { ...LAYOUT, tabs: [{ ...LAYOUT.tabs[0]!, title: 'x'.repeat(300_000) }] };
    expect((await put(huge, { jar: ann.jar, ifMatch: '"2"' })).status).toBe(413);
    expect(getLayout(t.rt.db, ann.id).version).toBe(2);
  });

  it('is scoped to the signed-in user', async () => {
    // Ben has his own row: version 0, empty, and Ann's version means nothing to him.
    expect(await (await get(ben.jar)).json()).toEqual({ layout: EMPTY_LAYOUT, version: 0 });
    expect((await put(LAYOUT, { jar: ben.jar, ifMatch: '"2"' })).status).toBe(409);
    expect((await put(LAYOUT, { jar: ben.jar, ifMatch: '"0"' })).status).toBe(200);
    expect(getLayout(t.rt.db, ann.id)).toEqual({ layout: EMPTY_LAYOUT, version: 2 });
    expect(getLayout(t.rt.db, ben.id)).toEqual({ layout: LAYOUT, version: 1 });
  });

  it('requires a session and a same-origin request', async () => {
    expect((await get()).status).toBe(401);
    expect((await put(LAYOUT, { ifMatch: '"0"' })).status).toBe(401);
    expect((await put(LAYOUT, { jar: ann.jar, origin: 'https://evil.example' })).status).toBe(403);
    expect((await put(LAYOUT, { jar: ann.jar, origin: null })).status).toBe(403);
    expect((await get(ann.jar, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await get(ann.jar, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('parses If-Match versions', () => {
    expect(parseIfMatch('"7"')).toBe(7);
    expect(parseIfMatch('7')).toBe(7);
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(parseIfMatch('"1", "2"')).toBeNull();
    expect(parseIfMatch('-1')).toBeNull();
    expect(parseIfMatch(null)).toBeNull();
  });
});
