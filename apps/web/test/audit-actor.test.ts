import { describe, expect, it } from 'vitest';
import { auditActorLabel } from '../lib/admin/audit-actor.ts';
import en from '../messages/en.json' with { type: 'json' };
import ptBR from '../messages/pt-BR.json' with { type: 'json' };

describe('audit viewer Actor column', () => {
  it('says "Unknown user" for anonymous sign-in failures and keeps "System" for system events', () => {
    const t = (key: 'system' | 'unknownUser') => en.admin.audit[key];
    const row = (type: string, actorId: string | null = null, actorName: string | null = null) => ({
      type,
      actorId,
      actorName,
    });
    expect(auditActorLabel(row('auth.login_failure'), t)).toBe('Unknown user');
    expect(auditActorLabel(row('auth.lockout'), t)).toBe('Unknown user');
    expect(auditActorLabel(row('host_key.mismatch'), t)).toBe('System');
    expect(auditActorLabel(row('auth.login_failure', '0199aaaa-bbbb', 'alice'), t)).toBe('alice');
    expect(auditActorLabel(row('user.ban', '0199aaaa-bbbb'), t)).toBe('0199aaaa');
    expect(ptBR.admin.audit.unknownUser).toBe('Usuário desconhecido');
  });
});
