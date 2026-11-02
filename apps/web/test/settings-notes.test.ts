import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTES_PREFERENCES } from '../lib/preferences/notes.ts';
import { getNotesPreferences, saveNotesPreferences } from '../lib/repo/preferences.ts';
import { createUser, makeRuntime, type TestRuntime } from './helpers.ts';

// The Server Action (lib/actions/settings.ts, saveNotesPreferences) runs against these stand-ins
// for Next.
const next = vi.hoisted(() => ({
  user: { id: '', role: 'user' as string | null },
  rt: null as unknown,
  revalidated: [] as string[],
}));
vi.mock('../lib/auth/server.ts', () => ({
  requireSession: async () => ({ user: next.user, session: {} }),
  getAuthRuntime: () => next.rt,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => next.revalidated.push(path),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));

const { saveNotesPreferences: saveAction } = await import('../lib/actions/settings.ts');

let t: TestRuntime;
let alice: string;
let bob: string;

beforeAll(async () => {
  t = makeRuntime();
  alice = (await createUser(t.rt, 'alice')).id;
  bob = (await createUser(t.rt, 'bob')).id;
  next.rt = t.rt;
});
afterAll(() => t.cleanup());
beforeEach(() => {
  next.user = { id: alice, role: 'user' };
  next.revalidated = [];
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe('saveNotesPreferences (plan D-59)', () => {
  it("saves the signed-in user's choice and refreshes the pages that read it", async () => {
    const state = await saveAction({}, form({ paper: 'slate', font: 'sans', fontSize: '18' }));
    expect(state).toMatchObject({ notice: 'settings.notes.saved' });
    expect(state.savedAt).toBeTypeOf('number');
    expect(getNotesPreferences(t.rt.db, alice)).toEqual({
      paper: 'slate',
      font: 'sans',
      fontSize: 18,
    });
    expect(getNotesPreferences(t.rt.db, bob)).toEqual(DEFAULT_NOTES_PREFERENCES);
    expect(next.revalidated).toEqual(['/settings/notes', '/workspace']);
  });

  it('refuses a size outside 12 to 20, or not a whole number, on the size field', async () => {
    saveNotesPreferences(t.rt.db, alice, { paper: 'paper', font: 'mono', fontSize: 16 });
    for (const fontSize of ['11', '21', '14.5', '', 'big']) {
      const state = await saveAction({}, form({ paper: 'contrast', font: 'mono', fontSize }));
      expect(state, fontSize).toEqual({
        fields: { fontSize: 'settings.notes.error.fontSize{"min":12,"max":20}' },
      });
    }
    // Nothing was stored, nothing refreshed.
    expect(getNotesPreferences(t.rt.db, alice)).toEqual({
      paper: 'paper',
      font: 'mono',
      fontSize: 16,
    });
    expect(next.revalidated).toEqual([]);
  });

  it('refuses an unknown paper or font with the form message', async () => {
    const refused: Record<string, string>[] = [
      { paper: 'velvet', font: 'mono', fontSize: '14' },
      { paper: 'auto', font: 'serif', fontSize: '14' },
      { font: 'mono', fontSize: '14' },
      { paper: 'auto', fontSize: '14' },
    ];
    for (const fields of refused) {
      const state = await saveAction({}, form(fields));
      expect(state, JSON.stringify(fields)).toEqual({ message: 'settings.notes.error.generic' });
    }
    expect(next.revalidated).toEqual([]);
  });

  it("only ever writes the caller's own row", async () => {
    next.user = { id: bob, role: 'user' };
    const before = getNotesPreferences(t.rt.db, alice);
    await saveAction({}, form({ paper: 'contrast', font: 'mono', fontSize: '20' }));
    expect(getNotesPreferences(t.rt.db, bob)).toEqual({
      paper: 'contrast',
      font: 'mono',
      fontSize: 20,
    });
    expect(getNotesPreferences(t.rt.db, alice)).toEqual(before);
  });
});
