'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { saveServer } from '../../lib/actions/servers.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import { withReturnPath } from '../../lib/manage/return-to.ts';
import type { ServerKind } from '../../lib/repo/servers.ts';
import { ROUTES, serverPath } from '../../lib/routes.ts';
import type { ServerOptionsValues } from '../../lib/servers/options.ts';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { AdvancedOptions, ServerTargetFields } from './server-fields.tsx';

/**
 * Edit a server on its page (plan D-29), with the field components of "Add server". The
 * credential is a saved one or none (the server asks in the terminal); "New credential" goes to
 * the credentials page and comes back here, where the select then lists it. Edits apply to new
 * sessions; running ones keep the target they started with.
 */
export function ServerForm({
  serverId,
  initial,
  options,
  credentials,
  localAllowed,
  localReason,
}: {
  serverId: string;
  /** The stored fields as form values (unprefixed names). */
  initial: Record<string, string>;
  options: ServerOptionsValues;
  credentials: Array<{ id: string; name: string }>;
  localAllowed: boolean;
  localReason: string | null;
}) {
  const t = useTranslations('servers.form');
  const ta = useTranslations('servers.addServer');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(saveServer, {} as ManageState);
  const errorPrefix = tf('errorPrefix');
  const values = state.values ?? initial;
  const fields = state.fields ?? {};
  const [kind, setKind] = useState<ServerKind>(initial.kind === 'local' ? 'local' : 'ssh');
  const errorCount = Object.keys(fields).length;

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.fields || Object.keys(state.fields).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={action} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="id" value={serverId} />
      <FormMessage message={state.message} />
      <ServerTargetFields
        values={values}
        fields={fields}
        errorPrefix={errorPrefix}
        kind={kind}
        onKindChange={setKind}
        localAllowed={localAllowed}
        localReason={localReason}
      />
      {kind === 'ssh' ? (
        <div className="flex flex-col gap-1.5">
          <Select
            name="credentialId"
            label={t('credential')}
            defaultValue={values.credentialId ?? ''}
            error={fields.credentialId}
            errorPrefix={errorPrefix}
            options={[
              ...credentials.map((c) => ({ value: c.id, label: c.name })),
              { value: '', label: t('credentialNone') },
            ]}
          />
          <p className="text-ink-muted text-sm">
            {credentials.length === 0 ? t('credentialEmpty') : t('credentialHelp')}{' '}
            {/* Comes back here afterwards (plan D-27); the select then lists the new one. */}
            <Link
              href={withReturnPath(ROUTES.credentials, serverPath(serverId))}
              className="inline-flex items-center gap-1 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
            >
              {t('credentialNew')}
            </Link>
          </p>
        </div>
      ) : null}
      <AdvancedOptions
        initial={options}
        values={values}
        fields={fields}
        errorPrefix={errorPrefix}
      />
      {errorCount > 0 ? (
        <Notice tone="danger">{ta('fixFields', { count: errorCount })}</Notice>
      ) : null}
      <div className="border-line border-t pt-5">
        <SubmitButton size="lg">{t('save')}</SubmitButton>
      </div>
    </form>
  );
}
