import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { Locale } from '../i18n/locales.ts';
import { auditDetailValue, DETAIL_KEYS, isDetailKey } from '../lib/admin/audit-detail.ts';
import en from '../messages/en.json' with { type: 'json' };
import ptBR from '../messages/pt-BR.json' with { type: 'json' };

const words = (messages: typeof en, locale: Locale) =>
  createTranslator({ locale, messages, namespace: 'admin.audit' });

describe('audit viewer Detail column', () => {
  it('labels every detail field in both languages', () => {
    for (const catalog of [en, ptBR]) {
      for (const key of DETAIL_KEYS) {
        expect(catalog.admin.audit.details.key, key).toHaveProperty(key);
      }
    }
  });

  it("labels a download's bytes sent and whether it completed (plan §5.12)", () => {
    // The daemon's file.download row: { serverId, path, size, bytes, completed }.
    expect(isDetailKey('bytes')).toBe(true);
    expect(isDetailKey('completed')).toBe(true);
    expect([en.admin.audit.details.key.bytes, en.admin.audit.details.key.completed]).toEqual([
      'Transferred',
      'Completed',
    ]);
    expect([ptBR.admin.audit.details.key.bytes, ptBR.admin.audit.details.key.completed]).toEqual([
      'Transferido',
      'Concluído',
    ]);
  });

  it('reads byte counts as sizes and completion as yes or no, in the UI language', () => {
    const t = words(en, 'en');
    expect(auditDetailValue('bytes', 1536, t, 'en')).toBe('1.5 KB');
    expect(auditDetailValue('size', 3 * 1024 * 1024, t, 'en')).toBe('3 MB');
    expect(auditDetailValue('bytes', 0, t, 'en')).toBe('0 B');
    expect(auditDetailValue('completed', true, t, 'en')).toBe('Yes');
    expect(auditDetailValue('completed', false, t, 'en')).toBe('No');

    const tp = words(ptBR, 'pt-BR');
    expect(auditDetailValue('bytes', 1536, tp, 'pt-BR')).toBe('1,5 KB');
    expect(auditDetailValue('completed', true, tp, 'pt-BR')).toBe('Sim');
    expect(auditDetailValue('completed', false, tp, 'pt-BR')).toBe('Não');
  });

  it('keeps the other values as they were', () => {
    const t = words(en, 'en');
    expect(auditDetailValue('port', 2222, t, 'en')).toBe('2222');
    expect(auditDetailValue('lockedForS', 30, t, 'en')).toBe('30 s');
    expect(auditDetailValue('method', 'backup_code', t, 'en')).toBe('Backup code');
    expect(auditDetailValue('method', 'carrier_pigeon', t, 'en')).toBe('carrier_pigeon');
    expect(auditDetailValue('fingerprint', 'x'.repeat(100), t, 'en')).toBe('x'.repeat(80));
  });
});
