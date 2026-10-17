'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import type { DiagnosticsState } from '../../lib/actions/server-states.ts';
import {
  pretrustFingerprint,
  replaceHostKey,
  testServer,
  trustHostKey,
} from '../../lib/actions/servers.ts';
import { connectCodeKey } from '../../lib/manage/connect-codes.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import { ChevronRightIcon } from '../icons/index.tsx';
import { DisclosureSummary } from '../ui/disclosure-summary.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { Tag } from '../ui/tag.tsx';
import { TextField } from '../ui/text-field.tsx';

const KEY_TYPES = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
];

/** A fingerprint as text that can be read off and compared: monospace, wraps anywhere. */
export function FingerprintText({ value }: { value: string }) {
  return <code className="break-all font-mono text-ink text-xs leading-5">{value}</code>;
}

/** Trusts exactly the pending key with this fingerprint, for the server's address. */
export function TrustKeyButton({
  serverId,
  keyType,
  fingerprint,
  label,
}: {
  serverId: string;
  keyType: string;
  fingerprint: string;
  label: string;
}) {
  const [state, action] = useActionState(trustHostKey, {} as ManageState);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="keyType" value={keyType} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <FormMessage message={state.message} />
      <SubmitButton size="sm">{label}</SubmitButton>
    </form>
  );
}

/**
 * "Replace trusted key" after a mismatch (plan §5.9): revokes the trusted key of that type and
 * trusts the given fingerprint for the whole address, only once the address is typed to confirm.
 */
export function ReplaceKeyForm({
  serverId,
  hostname,
  keyType,
  fingerprint,
}: {
  serverId: string;
  /** The server's stored address, which the user types to confirm. */
  hostname: string;
  keyType: string;
  fingerprint?: string;
}) {
  const t = useTranslations('servers.diagnostics.replace');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(replaceHostKey, {} as ManageState);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="keyType" value={keyType} />
      <p className="text-pretty text-base text-ink-muted">{t('intro')}</p>
      <FormMessage message={state.message} />
      <TextField
        name="fingerprint"
        label={t('fingerprint')}
        help={t('fingerprintHelp', { keyType })}
        defaultValue={state.values?.fingerprint ?? fingerprint ?? ''}
        error={state.fields?.fingerprint}
        errorPrefix={errorPrefix}
        mono
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
      />
      <TextField
        name="confirmHostname"
        label={t('confirm', { hostname })}
        help={t('confirmHelp')}
        defaultValue={state.values?.confirmHostname ?? ''}
        error={state.fields?.confirmHostname}
        errorPrefix={errorPrefix}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
      />
      <div>
        <SubmitButton variant="destructive" size="md" isolated={false}>
          {t('submit')}
        </SubmitButton>
      </div>
    </form>
  );
}

/** Pre-trust: a fingerprint obtained out of band, recorded before any connection. */
export function PretrustForm({ serverId }: { serverId: string }) {
  const t = useTranslations('servers.diagnostics.pretrust');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(pretrustFingerprint, {} as ManageState);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="serverId" value={serverId} />
      <p className="text-pretty text-base text-ink-muted">
        {t('intro')} <code className="font-mono text-ink text-sm">{t('command')}</code>
      </p>
      <FormMessage message={state.message} />
      <Select
        name="keyType"
        label={t('keyType')}
        defaultValue={state.values?.keyType ?? 'ssh-ed25519'}
        options={KEY_TYPES.map((value) => ({ value, label: value }))}
      />
      <TextField
        name="fingerprint"
        label={t('fingerprint')}
        help={t('fingerprintHelp')}
        error={state.fields?.fingerprint}
        errorPrefix={errorPrefix}
        placeholder="SHA256:…"
        mono
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
      />
      <div>
        <SubmitButton variant="secondary" size="md">
          {t('submit')}
        </SubmitButton>
      </div>
    </form>
  );
}

function ProbeReport({ result }: { result: NonNullable<DiagnosticsState['result']> }) {
  const t = useTranslations('servers.diagnostics.probe');
  const probe = result.probe;
  if (!probe) return null;
  const rows: Array<[string, string]> = [
    [t('tmux'), probe.tmuxVersion ? `${probe.tmuxVersion} · ${probe.tmuxPath}` : t('tmuxMissing')],
    [t('locale'), probe.utf8Locale ?? t('localeMissing')],
    [t('shell'), probe.shell ?? t('unknown')],
  ];
  return (
    <div className="flex flex-col gap-3">
      <h4 className="font-semibold text-ink text-sm">{t('title')}</h4>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 border-line border-y text-base">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="border-line border-t py-2 text-ink-muted text-sm [div:first-child>&]:border-t-0">
              {label}
            </dt>
            <dd className="break-words border-line border-t py-2 text-ink [div:first-child>&]:border-t-0">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {probe.protection === 'tmux-control' ? (
        <Notice tone="success" title={t('protected')}>
          {t('protectedBody')}
        </Notice>
      ) : (
        <Notice tone="info" title={t('unprotected')}>
          {t(`reason.${probe.reason ?? 'no_tmux'}`)}
        </Notice>
      )}
      {probe.lingerWarning ? (
        <Notice tone="warning" title={t('lingerTitle')}>
          {t('lingerBody')}
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * "Test connection" (plan §5.9): connects to the server's address, shows the presented key's
 * type and SHA256 fingerprint, and records an unknown key as pending so it can be trusted here.
 * Once the key is trusted it also signs in as the server's user and runs the capability probe.
 */
export function TestConnection({
  serverId,
  hostname,
  hasCredential,
}: {
  serverId: string;
  hostname: string;
  /** Without a stored credential the server asks in the terminal, so the probe cannot sign in. */
  hasCredential: boolean;
}) {
  const t = useTranslations('servers.diagnostics');
  const [state, action] = useActionState(testServer, {} as DiagnosticsState);
  const result = state.result;
  const key = result?.hostKey ?? null;
  const mismatch = result?.error === 'HOST_KEY_MISMATCH';
  // A key the owner revoked is refused like a mismatch, but says what it is.
  const revoked = mismatch && result?.revoked === true;

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="serverId" value={serverId} />
        <div>
          <SubmitButton size="md" icon={<ChevronRightIcon size={16} />}>
            {t('test.submit')}
          </SubmitButton>
        </div>
        <p className="text-ink-muted text-sm">{t('test.help')}</p>
      </form>

      <div aria-live="polite" className="flex flex-col gap-4 empty:hidden">
        {state.message ? <Notice tone="danger">{state.message}</Notice> : null}
        {result && !result.reachable ? (
          <Notice tone="danger" title={t('result.unreachable')}>
            {t(`code.${connectCodeKey(result.error)}`)}
          </Notice>
        ) : null}
        {key ? (
          <div className="flex flex-col gap-3 rounded-control bg-field px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink text-sm">{t('result.presented')}</span>
              <Tag tone={key.trusted ? 'success' : mismatch ? 'danger' : 'warning'}>
                {key.trusted
                  ? t('status.trusted')
                  : revoked
                    ? t('status.revoked')
                    : mismatch
                      ? t('status.mismatch')
                      : t('status.pending')}
              </Tag>
            </div>
            <p className="text-ink-muted text-sm">{key.type}</p>
            <FingerprintText value={key.fingerprint} />
            {!key.trusted && !mismatch ? (
              <>
                <p className="text-pretty text-ink-muted text-sm">{t('result.compare')}</p>
                <TrustKeyButton
                  serverId={serverId}
                  keyType={key.type}
                  fingerprint={key.fingerprint}
                  label={t('trust')}
                />
              </>
            ) : null}
          </div>
        ) : null}
        {mismatch && key ? (
          <>
            <Notice
              tone="danger"
              title={revoked ? t('result.revokedTitle') : t('result.mismatchTitle')}
            >
              {revoked ? t('result.revokedBody') : t('result.mismatchBody')}
            </Notice>
            <details className="group/disclosure rounded-control border border-line-strong px-4 py-3">
              <DisclosureSummary className="font-semibold text-ink text-sm">
                {t('replace.title')}
              </DisclosureSummary>
              <div className="mt-3">
                <ReplaceKeyForm
                  serverId={serverId}
                  hostname={hostname}
                  keyType={key.type}
                  fingerprint={key.fingerprint}
                />
              </div>
            </details>
          </>
        ) : null}
        {result?.reachable && key?.trusted && result.error ? (
          <Notice tone="warning" title={t('result.loginFailed')}>
            {hasCredential ? t(`code.${connectCodeKey(result.error)}`) : t('result.noCredential')}
          </Notice>
        ) : null}
        {result?.reachable && key?.trusted && !result.probe && !result.error ? (
          <p className="text-ink-muted text-sm">
            {hasCredential ? t('result.noProbe') : t('result.noCredential')}
          </p>
        ) : null}
        {result ? <ProbeReport result={result} /> : null}
      </div>
    </div>
  );
}
