import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAuthSessionValidator, SqliteOwnership } from '../../src/store/access.ts';
import { insertAuthSession, insertUser, type TempDb, tempDb } from './fixture.ts';

let fixture: TempDb;
afterEach(() => fixture?.cleanup());

describe('SqliteAuthSessionValidator / SqliteOwnership', () => {
  it('requires a live auth session of that user, honouring ban_expires', async () => {
    fixture = tempDb();
    const { db } = fixture;
    const now = 10_000_000;
    const validator = new SqliteAuthSessionValidator(db, () => now);
    const user = insertUser(db);
    const other = insertUser(db);
    const live = insertAuthSession(db, user, now + 1_000);
    expect(validator.isValid(live, user)).toBe(true);
    expect(validator.isValid(live, other)).toBe(false); // not that user's session
    expect(validator.isValid('missing', user)).toBe(false);
    expect(validator.isValid(insertAuthSession(db, user, now), user)).toBe(false); // expired

    const banned = insertUser(db, { banned: true });
    expect(validator.isValid(insertAuthSession(db, banned, now + 1_000), banned)).toBe(false);
    const lapsed = insertUser(db, { banned: true, banExpires: now - 1 });
    expect(validator.isValid(insertAuthSession(db, lapsed, now + 1_000), lapsed)).toBe(true);
    const until = insertUser(db, { banned: true, banExpires: now + 60_000 });
    expect(validator.isValid(insertAuthSession(db, until, now + 1_000), until)).toBe(false);

    expect(await new SqliteOwnership(db).sessionOwner('missing')).toBeNull();
  });
});
