'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '../auth/server.ts';
import { getInternalApi, isInternalApiError } from '../internal-api.ts';
import { type ManageState, text } from '../manage/forms.ts';
import { serviceErrorKey } from '../manage/service-errors.ts';
import type { CredentialCreateState, CredentialKind } from './credential-states.ts';

/**
 * Credentials (plan §8.1 /credentials): created, renamed and deleted by the daemon, which owns
 * the vault. Secrets travel once from the form to the internal API and are never echoed back:
 * a failed submit keeps only the name and kind.
 */

const NAME_MAX = 120;

export async function createCredential(
  _prev: CredentialCreateState,
  formData: FormData,
): Promise<CredentialCreateState> {
  const { user } = await requireSession();
  const t = await getTranslations('credentials.error');
  const kindRaw = text(formData, 'kind');
  const kind: CredentialKind =
    kindRaw === 'private_key' || kindRaw === 'generate' ? kindRaw : 'password';
  const name = text(formData, 'name').trim();
  const values = { name, kind };
  const fields: Record<string, string> = {};
  if (!name) fields.name = t('nameRequired');
  else if (name.length > NAME_MAX) fields.name = t('nameLong');

  const password = text(formData, 'password');
  const privateKey = text(formData, 'privateKey').trim();
  const passphrase = text(formData, 'passphrase');
  if (kind === 'password' && !password) fields.password = t('passwordRequired');
  if (kind === 'private_key' && !privateKey) fields.privateKey = t('privateKeyRequired');
  if (kind === 'private_key' && privateKey.length > 32_768) fields.privateKey = t('privateKeyLong');
  if (Object.keys(fields).length > 0) return { fields, values };

  try {
    const api = getInternalApi();
    const result =
      kind === 'password'
        ? await api.createCredential({ actingUserId: user.id, kind, name, password })
        : kind === 'private_key'
          ? await api.createCredential({
              actingUserId: user.id,
              kind,
              name,
              privateKey: `${privateKey}\n`,
              ...(passphrase ? { passphrase } : {}),
            })
          : await api.createCredential({
              actingUserId: user.id,
              kind,
              name,
              algorithm: 'ed25519',
            });
    revalidatePath('/credentials');
    return {
      savedAt: Date.now(),
      created: {
        name,
        kind,
        publicKey: kind === 'generate' ? result.publicKey : null,
        fingerprint: result.fingerprint,
      },
    };
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    if (err.code === 'CREDENTIAL_INVALID') {
      return { fields: { privateKey: t('privateKeyInvalid') }, values };
    }
    return { message: t(serviceErrorKey(err)), values };
  }
}

export async function renameCredential(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('credentials.error');
  const id = text(formData, 'id');
  const name = text(formData, 'name').trim();
  if (!name) return { fields: { name: t('nameRequired') }, values: { name } };
  if (name.length > NAME_MAX) return { fields: { name: t('nameLong') }, values: { name } };
  try {
    await getInternalApi().renameCredential(id, user.id, name);
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    return { message: t(serviceErrorKey(err)), values: { name } };
  }
  redirect('/credentials?done=renamed');
}

export async function deleteCredential(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('credentials.error');
  try {
    await getInternalApi().deleteCredential(text(formData, 'id'), user.id);
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    if (err.kind === 'conflict') return { message: t('inUse') };
    return { message: t(serviceErrorKey(err)) };
  }
  redirect('/credentials?done=deleted');
}
