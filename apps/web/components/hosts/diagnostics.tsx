'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import type { DiagnosticsState } from '../../lib/actions/host-states.ts';
import {
  fetchHostKey,
  pretrustFingerprint,
  replaceHostKey,
  trustHostKey,
} from '../../lib/actions/hosts.ts';
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

/** Trusts exactly the pending key with this fingerprint. */
export function TrustKeyButton({
  hostId,
  keyType,
  fingerprint,
  label,
}: {
  hostId: string;
  keyType: string;
  fingerprint: string;
  label: string;
}) {
  const [state, action] = useActionState(trustHostKey, {} as ManageState);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="hostId" value={hostId} />
      <input type="hidden" name="keyType" value={keyType} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <FormMessage message={state.message} />
      <SubmitButton size="sm">{label}</SubmitButton>
    </form>
  );
}

/**
 * "Replace trusted key" after a mismatch (plan §5.9): revokes the trusted key of that type and
 * trusts the given fingerprint, only once the host's name is typed to confirm.
 */
export function ReplaceKeyForm({
  hostId,
  hostName,
  keyType,
  fingerprint,
}: {
  hostId: string;
  hostName: string;
  keyType: string;
  fingerprint?: string;
}) {
  const t = useTranslations('hosts.diagnostics.replace');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(replaceHostKey, {} as ManageState);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="hostId" value={hostId} />
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
        name="confirmHostName"
        label={t('confirm', { name: hostName })}
        help={t('confirmHelp')}
        error={state.fields?.confirmHostName}
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
export function PretrustForm({ hostId }: { hostId: string }) {
  const t = useTranslations('hosts.diagnostics.pretrust');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(pretrustFingerprint, {} as ManageState);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="hostId" value={hostId} />
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
  const t = useTranslations('hosts.diagnostics.probe');
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
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 border-rule border-y text-base">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="border-rule border-t py-2 text-ink-muted text-sm first:border-t-0">
              {label}
            </dt>
            <dd className="break-words border-rule border-t py-2 text-ink">{value}</dd>
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
 * "Fetch & verify" (plan §5.9): connects to the host, shows the presented key's type and SHA256
 * fingerprint, and records an unknown key as pending so it can be trusted here. With a profile
 * whose key is already trusted it also logs in and runs the capability probe.
 */
export function FetchVerify({
  hostId,
  hostName,
  profiles,
}: {
  hostId: string;
  hostName: string;
  profiles: Array<{ id: string; name: string; username: string }>;
}) {
  const t = useTranslations('hosts.diagnostics');
  const [state, action] = useActionState(fetchHostKey, {} as DiagnosticsState);
  const result = state.result;
  const key = result?.hostKey ?? null;
  const mismatch = result?.error === 'HOST_KEY_MISMATCH';
  // A key the owner revoked is refused like a mismatch, but says what it is.
  const revoked = mismatch && result?.revoked === true;

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="hostId" value={hostId} />
        {profiles.length > 0 ? (
          <Select
            name="profileId"
            label={t('fetch.profile')}
            help={t('fetch.profileHelp')}
            defaultValue=""
            options={[
              { value: '', label: t('fetch.profileNone') },
              ...profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.username})` })),
            ]}
          />
        ) : null}
        <div>
          <SubmitButton size="md" icon={<ChevronRightIcon size={16} />}>
            {t('fetch.submit')}
          </SubmitButton>
        </div>
        <p className="text-ink-muted text-sm">{t('fetch.help')}</p>
      </form>

      <div aria-live="polite" className="flex flex-col gap-4 empty:hidden">
        {state.message ? <Notice tone="danger">{state.message}</Notice> : null}
        {result && !result.reachable ? (
          <Notice tone="danger" title={t('result.unreachable')}>
            {t(`code.${codeKey(result.error)}`)}
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
                  hostId={hostId}
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
            <details className="group/disclosure rounded-control border border-rule-strong px-4 py-3">
              <DisclosureSummary className="font-semibold text-ink text-sm">
                {t('replace.title')}
              </DisclosureSummary>
              <div className="mt-3">
                <ReplaceKeyForm
                  hostId={hostId}
                  hostName={hostName}
                  keyType={key.type}
                  fingerprint={key.fingerprint}
                />
              </div>
            </details>
          </>
        ) : null}
        {result?.reachable && key?.trusted && result.error ? (
          <Notice tone="warning" title={t('result.loginFailed')}>
            {t(`code.${codeKey(result.error)}`)}
          </Notice>
        ) : null}
        {result?.reachable && key?.trusted && !result.probe && !result.error ? (
          <p className="text-ink-muted text-sm">
            {state.profileName ? t('result.noProbe') : t('result.pickProfile')}
          </p>
        ) : null}
        {result ? <ProbeReport result={result} /> : null}
      </div>
    </div>
  );
}

const KNOWN_CODES = [
  'HOST_UNREACHABLE',
  'TARGET_NOT_ALLOWED',
  'HOST_KEY_MISMATCH',
  'AUTH_REJECTED',
  'AUTH_TIMEOUT',
  'CREDENTIAL_INVALID',
  'PROBE_TIMEOUT',
  'PROBE_TOO_LARGE',
  'CONNECTION_LOST',
] as const;
type KnownCode = (typeof KNOWN_CODES)[number];

function codeKey(code: string | null): KnownCode | 'OTHER' {
  return code && (KNOWN_CODES as readonly string[]).includes(code) ? (code as KnownCode) : 'OTHER';
}
