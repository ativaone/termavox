'use server';

import { ErrorCode, TermdockError } from '@termdock/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { changePassword } from '../auth/account.ts';
import { getAuthRuntime, requireSession } from '../auth/server.ts';
import { authErrorInfo } from '../auth-errors.ts';
import { revokeConnections } from '../internal-api.ts';
import { checked, integer, type ManageState, text } from '../manage/forms.ts';
import { TerminalPreferencesInput } from '../preferences/terminal.ts';
import { saveTerminalPreferences as savePreferencesRow } from '../repo/preferences.ts';
import { ROUTES } from '../routes.ts';

/** The user's own settings (plan §8.1 /settings/account and /settings/terminal). */

export async function saveTerminalPreferences(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('settings.terminal');
  const parsed = TerminalPreferencesInput.safeParse({
    fontFamily: text(formData, 'fontFamily'),
    fontSize: integer(formData, 'fontSize'),
    colorScheme: text(formData, 'colorScheme'),
    cursorStyle: text(formData, 'cursorStyle'),
    cursorBlink: checked(formData, 'cursorBlink'),
    copyOnSelect: checked(formData, 'copyOnSelect'),
    rightClickPaste: checked(formData, 'rightClickPaste'),
    allowOsc52Write: checked(formData, 'allowOsc52Write'),
    confirmLinks: checked(formData, 'confirmLinks'),
  });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    return field === 'fontSize'
      ? { fields: { fontSize: t('error.fontSize') } }
      : { message: t('error.generic') };
  }
  savePreferencesRow(getAuthRuntime().db, user.id, parsed.data);
  revalidatePath('/settings/terminal');
  return { notice: t('saved'), savedAt: Date.now() };
}

function passwordProblem(password: string): 'passwordShort' | 'passwordLong' | null {
  if (password.length < 12) return 'passwordShort';
  if (password.length > 128) return 'passwordLong';
  return null;
}

/**
 * The voluntary password change on /settings/account: same rules and auth core as the forced
 * change (lib/actions/auth.ts), but the user stays on the page. Other browsers are signed out.
 */
export async function changePasswordInSettings(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  await requireSession();
  const t = await getTranslations('auth.changePassword.error');
  const ts = await getTranslations('settings.account.password');
  const currentPassword = text(formData, 'currentPassword');
  const newPassword = text(formData, 'newPassword');
  const confirm = text(formData, 'confirm');
  const fields: Record<string, string> = {};
  if (!currentPassword) fields.currentPassword = t('current');
  const weak = passwordProblem(newPassword);
  if (weak) fields.newPassword = t(weak);
  else if (newPassword === currentPassword) fields.newPassword = t('unchanged');
  else if (newPassword !== confirm) fields.confirm = t('mismatch');
  if (Object.keys(fields).length > 0) return { fields };

  let unauthenticated = false;
  try {
    await changePassword(
      getAuthRuntime(),
      await headers(),
      { currentPassword, newPassword },
      revokeConnections,
    );
  } catch (err) {
    if (!(err instanceof TermdockError)) throw err;
    const code = err.details?.betterAuthCode;
    if (err.code === ErrorCode.Unauthenticated) unauthenticated = true;
    else if (code === 'INVALID_PASSWORD') return { fields: { currentPassword: t('current') } };
    else if (code === 'PASSWORD_UNCHANGED') return { fields: { newPassword: t('unchanged') } };
    else if (code === 'PASSWORD_TOO_SHORT') return { fields: { newPassword: t('passwordShort') } };
    else if (code === 'PASSWORD_TOO_LONG') return { fields: { newPassword: t('passwordLong') } };
    else return { message: t('generic') };
  }
  if (unauthenticated) redirect(ROUTES.login);
  return { notice: ts('changed'), savedAt: Date.now() };
}

/** Turns TOTP off after the password is confirmed; refused while TOTP is required. */
export async function disableTotp(_prev: ManageState, formData: FormData): Promise<ManageState> {
  await requireSession();
  const t = await getTranslations('settings.account.totp.error');
  const password = text(formData, 'password');
  if (!password) return { fields: { password: t('password') } };
  try {
    await getAuthRuntime().auth.api.disableTwoFactor({
      body: { password },
      headers: await headers(),
    });
  } catch (err) {
    const info = authErrorInfo(err);
    if (!info) throw err;
    if (info.code === 'INVALID_PASSWORD') return { fields: { password: t('password') } };
    if (info.code === 'TOTP_REQUIRED') return { message: t('required') };
    return { message: t('generic') };
  }
  redirect('/settings/account?done=totpDisabled');
}
