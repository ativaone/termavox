'use server';

import { ErrorCode, isTermavoxError } from '@termavox/shared';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { isLocale, LOCALE_COOKIE } from '../../i18n/locales.ts';
import { changePassword, signOutSession } from '../auth/account.ts';
import { completeSetup, getAuthRuntime } from '../auth/server.ts';
import { type AuthErrorInfo, authErrorInfo } from '../auth-errors.ts';
import { revokeConnections } from '../internal-api.ts';
import { qrPath } from '../qr.ts';
import { setUserLocale } from '../repo/users.ts';
import { ROUTES } from '../routes.ts';
import type { EnrollState, FormState } from './form-state.ts';

/**
 * Server Actions for the auth surfaces. Each one calls the Better Auth server API through the
 * process-wide auth runtime (nextCookies() carries Set-Cookie into the response) and maps
 * failures to localized messages. Redirects happen outside every try block: redirect() throws.
 */

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * The locale switcher's cookie is the user's most recent explicit choice, so a sign-in on a
 * browser where it is set stores it as the account preference.
 */
async function syncLocaleFromCookie(userId: string): Promise<void> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(value)) setUserLocale(getAuthRuntime().db, userId, value);
}

function userIdOf(result: unknown): string | undefined {
  const id = (result as { user?: { id?: unknown } } | null | undefined)?.user?.id;
  return typeof id === 'string' ? id : undefined;
}

function passwordProblem(password: string): 'passwordShort' | 'passwordLong' | null {
  if (password.length < 12) return 'passwordShort';
  if (password.length > 128) return 'passwordLong';
  return null;
}

type SignInError =
  | { key: 'invalid' | 'rateLimited' | 'disabled' | 'generic' }
  | { key: 'lockedSeconds'; seconds: number }
  | { key: 'lockedMinutes'; minutes: number };

/** Never says which field was wrong: unknown usernames and wrong passwords read the same. */
function signInError(info: AuthErrorInfo): SignInError {
  if (info.status === 429 && info.code === 'SIGN_IN_LOCKED') {
    const seconds = Math.max(1, info.retryAfterS ?? 30);
    return seconds <= 90
      ? { key: 'lockedSeconds', seconds }
      : { key: 'lockedMinutes', minutes: Math.ceil(seconds / 60) };
  }
  if (info.status === 429) return { key: 'rateLimited' };
  if (info.status === 403 && info.code === 'BANNED_USER') return { key: 'disabled' };
  if (info.status === 401 || info.status === 400 || info.status === 422) return { key: 'invalid' };
  return { key: 'generic' };
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getTranslations('auth.login.error');
  const username = text(formData, 'username').trim();
  const password = text(formData, 'password');
  const values = { username };
  if (!username || !password) return { message: t('missing'), values };

  let result: unknown;
  try {
    result = await getAuthRuntime().auth.api.signInUsername({
      body: { username, password, rememberMe: true },
      headers: await headers(),
    });
  } catch (err) {
    const info = authErrorInfo(err);
    if (!info) throw err;
    const error = signInError(info);
    if (error.key === 'lockedSeconds') {
      return { message: t('lockedSeconds', { seconds: error.seconds }), values };
    }
    if (error.key === 'lockedMinutes') {
      return { message: t('lockedMinutes', { minutes: error.minutes }), values };
    }
    return { message: t(error.key), values };
  }

  if ((result as { twoFactorRedirect?: unknown }).twoFactorRedirect === true) {
    redirect(ROUTES.twoFactor);
  }
  const userId = userIdOf(result);
  if (userId) await syncLocaleFromCookie(userId);
  redirect(ROUTES.workspace);
}

export async function verifyTwoFactor(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getTranslations('auth.twoFactor.error');
  const mode = text(formData, 'mode') === 'backup' ? 'backup' : 'totp';
  const trustDevice = formData.get('trustDevice') === 'on';
  const code =
    mode === 'totp' ? text(formData, 'code').replace(/\s+/g, '') : text(formData, 'code').trim();
  const values = { mode, trustDevice: trustDevice ? 'on' : '' };
  if (mode === 'totp' && !/^\d{6}$/.test(code)) return { fields: { code: t('format') }, values };
  if (mode === 'backup' && !code) return { fields: { code: t('backupFormat') }, values };

  const api = getAuthRuntime().auth.api;
  const requestHeaders = await headers();
  let result: unknown;
  let expired = false;
  try {
    result =
      mode === 'totp'
        ? await api.verifyTOTP({ body: { code, trustDevice }, headers: requestHeaders })
        : await api.verifyBackupCode({ body: { code, trustDevice }, headers: requestHeaders });
  } catch (err) {
    const info = authErrorInfo(err);
    if (!info) throw err;
    switch (info.code) {
      case 'INVALID_TWO_FACTOR_COOKIE':
        expired = true;
        break;
      case 'INVALID_CODE':
        return { fields: { code: t('invalid') }, values };
      case 'INVALID_BACKUP_CODE':
        return { fields: { code: t('invalidBackup') }, values };
      case 'ACCOUNT_TEMPORARILY_LOCKED':
        return { message: t('locked'), values };
      case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
        return { message: t('tooManyAttempts'), values };
      default:
        return { message: t('generic'), values };
    }
  }
  if (expired) redirect(`${ROUTES.login}?notice=expired`);
  const userId = userIdOf(result);
  if (userId) await syncLocaleFromCookie(userId);
  redirect(ROUTES.workspace);
}

export async function setUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getTranslations('auth.setup.error');
  const token = text(formData, 'token').trim();
  const username = text(formData, 'username').trim();
  const email = text(formData, 'email').trim();
  const password = text(formData, 'password');
  const confirm = text(formData, 'confirm');
  const values = { username, email };

  const fields: Record<string, string> = {};
  if (!token) fields.token = t('token');
  if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username)) fields.username = t('username');
  if (!z.email().safeParse(email).success) fields.email = t('email');
  const weak = passwordProblem(password);
  if (weak) fields.password = t(weak);
  else if (password !== confirm) fields.confirm = t('mismatch');
  if (Object.keys(fields).length > 0) return { fields, values };

  let userId: string | undefined;
  let closed = false;
  try {
    ({ userId } = await completeSetup(token, { username, email, password }));
  } catch (err) {
    if (!isTermavoxError(err)) throw err;
    switch (err.code) {
      case ErrorCode.NotFound:
        closed = true;
        break;
      case ErrorCode.Forbidden:
        return { fields: { token: t('token') }, values };
      case ErrorCode.Conflict:
        return { message: t('busy'), values };
      case ErrorCode.BadRequest:
        return { message: t('rejected'), values };
      default:
        return { message: t('generic'), values };
    }
  }
  if (closed || !userId) redirect(ROUTES.login);

  const runtime = getAuthRuntime();
  const locale = await getLocale();
  if (isLocale(locale)) setUserLocale(runtime.db, userId, locale);
  // Sign the new admin in; if that fails for any reason, the login page takes over.
  let signedIn = false;
  try {
    await runtime.auth.api.signInUsername({
      body: { username, password, rememberMe: true },
      headers: await headers(),
    });
    signedIn = true;
  } catch (err) {
    if (!authErrorInfo(err)) throw err;
  }
  redirect(signedIn ? ROUTES.workspace : ROUTES.login);
}

export async function changeOwnPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getTranslations('auth.changePassword.error');
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
    if (!isTermavoxError(err)) throw err;
    const code = err.details?.betterAuthCode;
    if (err.code === ErrorCode.Unauthenticated) unauthenticated = true;
    else if (code === 'INVALID_PASSWORD') return { fields: { currentPassword: t('current') } };
    else if (code === 'PASSWORD_UNCHANGED') return { fields: { newPassword: t('unchanged') } };
    else if (code === 'PASSWORD_TOO_SHORT') return { fields: { newPassword: t('passwordShort') } };
    else if (code === 'PASSWORD_TOO_LONG') return { fields: { newPassword: t('passwordLong') } };
    else return { message: t('generic') };
  }
  // The gate sends the user on to a pending TOTP enrollment, if any.
  redirect(unauthenticated ? ROUTES.login : ROUTES.workspace);
}

export async function enrollTotp(prev: EnrollState, formData: FormData): Promise<EnrollState> {
  const t = await getTranslations('auth.enrollTotp.error');
  const api = getAuthRuntime().auth.api;
  const requestHeaders = await headers();
  const intent = text(formData, 'intent');

  if (intent === 'start') {
    const password = text(formData, 'password');
    if (!password) return { step: 'password', fields: { password: t('password') } };
    let unauthenticated = false;
    try {
      const enabled = await api.enableTwoFactor({
        body: { password, method: 'totp' },
        headers: requestHeaders,
      });
      if (enabled.method !== 'totp') return { step: 'password', message: t('generic') };
      const secret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
      return {
        step: 'verify',
        qr: qrPath(enabled.totpURI),
        secret,
        backupCodes: enabled.backupCodes,
      };
    } catch (err) {
      const info = authErrorInfo(err);
      if (!info) throw err;
      if (info.code === 'INVALID_PASSWORD') {
        return { step: 'password', fields: { password: t('password') } };
      }
      if (info.code === 'TOTP_ALREADY_ENABLED') return { step: 'password', message: t('enrolled') };
      if (info.status !== 401) return { step: 'password', message: t('generic') };
      unauthenticated = true;
    }
    if (unauthenticated) redirect(ROUTES.login);
  }

  if (intent === 'verify' && prev.step === 'verify') {
    const code = text(formData, 'code').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code))
      return { ...prev, message: undefined, fields: { code: t('format') } };
    try {
      await api.verifyTOTP({ body: { code }, headers: requestHeaders });
    } catch (err) {
      const info = authErrorInfo(err);
      if (!info) throw err;
      if (info.code === 'INVALID_CODE') {
        return { ...prev, message: undefined, fields: { code: t('invalid') } };
      }
      return { ...prev, message: t('generic'), fields: undefined };
    }
    return { step: 'done', backupCodes: prev.backupCodes };
  }
  return prev;
}

export async function signOut(): Promise<void> {
  try {
    // Also closes this auth session's WebSockets at once (other sessions stay signed in).
    await signOutSession(getAuthRuntime(), await headers(), revokeConnections);
  } catch (err) {
    if (!isTermavoxError(err)) throw err;
  }
  redirect(ROUTES.login);
}
