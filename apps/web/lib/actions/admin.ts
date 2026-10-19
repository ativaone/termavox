'use server';

import { ErrorCode, isTermdockError, type TermdockError } from '@termdock/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import {
  type AdminDeps,
  adminCreateUser,
  adminResetPassword,
  adminResetTotp,
  adminSaveSettings,
  adminSetBanned,
  adminSetRole,
} from '../admin/core.ts';
import { getAuthRuntime } from '../auth/server.ts';
import { getInternalApi } from '../internal-api.ts';
import { checked, integer, type ManageState, text } from '../manage/forms.ts';
import { ROUTES } from '../routes.ts';

/**
 * Admin Server Actions (plan §8.1 /admin/*). The work and the role check live in lib/admin/core;
 * here a non-admin caller gets the not-found page, and an expired session the login page.
 */

function deps(): AdminDeps {
  const runtime = getAuthRuntime();
  // The internal API is resolved lazily: only bans and resets need it.
  return {
    auth: runtime.auth,
    db: runtime.db,
    internalApi: {
      revokeAuthSessions: (target) => getInternalApi().revokeAuthSessions(target),
      terminateUserSessions: (userId, actingUserId) =>
        getInternalApi().terminateUserSessions(userId, actingUserId),
    },
  };
}

/** Maps the guard's errors to Next navigation; returns other TermdockErrors to the caller. */
function guard(err: unknown): TermdockError {
  if (!isTermdockError(err)) throw err;
  if (err.code === ErrorCode.NotFound && err.message === 'not found') notFound();
  if (err.code === ErrorCode.Unauthenticated) redirect(ROUTES.login);
  return err;
}

const userPath = (id: string) => `/admin/users/${encodeURIComponent(id)}`;

const USERNAME = /^[a-zA-Z0-9_.]{3,30}$/;

export async function createUser(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const t = await getTranslations('admin.users.error');
  const username = text(formData, 'username').trim();
  const email = text(formData, 'email').trim();
  const name = text(formData, 'name').trim();
  const temporaryPassword = text(formData, 'temporaryPassword');
  const role = text(formData, 'role') === 'admin' ? 'admin' : 'user';
  const totpRequired = checked(formData, 'totpRequired');
  const values = { username, email, name, role, totpRequired: totpRequired ? 'on' : '' };
  const fields: Record<string, string> = {};
  if (!USERNAME.test(username)) fields.username = t('username');
  if (!z.email().safeParse(email).success) fields.email = t('email');
  if (name.length > 100) fields.name = t('nameLong');
  if (temporaryPassword.length < 12) fields.temporaryPassword = t('passwordShort');
  else if (temporaryPassword.length > 128) fields.temporaryPassword = t('passwordLong');
  if (Object.keys(fields).length > 0) return { fields, values };

  let userId: string;
  try {
    ({ userId } = await adminCreateUser(deps(), await headers(), {
      username,
      email,
      ...(name ? { name } : {}),
      temporaryPassword,
      role,
      totpRequired,
    }));
  } catch (err) {
    const e = guard(err);
    const code = e.details?.betterAuthCode;
    if (code === 'USERNAME_IS_ALREADY_TAKEN') {
      return { fields: { username: t('usernameTaken') }, values };
    }
    if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
      return { fields: { email: t('emailTaken') }, values };
    }
    return { message: t('createFailed'), values };
  }
  redirect(`${userPath(userId)}?done=created`);
}

export async function setUserBanned(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const t = await getTranslations('admin.users');
  const userId = text(formData, 'userId');
  const banned = text(formData, 'banned') === '1';
  const terminateSessions = checked(formData, 'terminateSessions');
  let notice: string;
  let warning: string | undefined;
  try {
    const outcome = await adminSetBanned(deps(), await headers(), {
      userId,
      banned,
      terminateSessions,
    });
    if (!banned) notice = t('notice.enabled');
    else {
      notice =
        outcome.terminated !== null
          ? t('notice.disabledTerminated', { count: outcome.terminated })
          : t('notice.disabled');
      if (!outcome.connectionsClosed) warning = t('notice.connectionsOpen');
      if (outcome.terminateFailed) warning = t('notice.terminateFailed');
    }
  } catch (err) {
    const e = guard(err);
    if (e.code === ErrorCode.BadRequest && e.message.includes('own')) {
      return { message: t('error.self') };
    }
    if (e.code === ErrorCode.NotFound) return { message: t('error.notFound') };
    return { message: t('error.generic') };
  }
  revalidatePath(userPath(userId));
  return { notice, ...(warning ? { message: warning } : {}), savedAt: Date.now() };
}

export async function resetUserTotp(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const t = await getTranslations('admin.users');
  const userId = text(formData, 'userId');
  try {
    await adminResetTotp(deps(), await headers(), userId);
  } catch (err) {
    const e = guard(err);
    return { message: e.code === ErrorCode.NotFound ? t('error.notFound') : t('error.generic') };
  }
  redirect(`${userPath(userId)}?done=totpReset`);
}

export async function resetUserPassword(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const t = await getTranslations('admin.users');
  const userId = text(formData, 'userId');
  const temporaryPassword = text(formData, 'temporaryPassword');
  if (temporaryPassword.length < 12) {
    return { fields: { temporaryPassword: t('error.passwordShort') } };
  }
  if (temporaryPassword.length > 128) {
    return { fields: { temporaryPassword: t('error.passwordLong') } };
  }
  let connectionsClosed = true;
  try {
    ({ connectionsClosed } = await adminResetPassword(deps(), await headers(), {
      userId,
      temporaryPassword,
    }));
  } catch (err) {
    const e = guard(err);
    return { message: e.code === ErrorCode.NotFound ? t('error.notFound') : t('error.generic') };
  }
  revalidatePath(userPath(userId));
  return {
    notice: t('notice.passwordReset'),
    ...(connectionsClosed ? {} : { message: t('notice.connectionsOpen') }),
    savedAt: Date.now(),
  };
}

export async function setUserRole(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const t = await getTranslations('admin.users');
  const userId = text(formData, 'userId');
  const role = text(formData, 'role') === 'admin' ? 'admin' : 'user';
  try {
    await adminSetRole(deps(), await headers(), { userId, role });
  } catch (err) {
    const e = guard(err);
    if (e.code === ErrorCode.BadRequest && e.message.includes('own')) {
      return { message: t('error.selfRole') };
    }
    return { message: e.code === ErrorCode.NotFound ? t('error.notFound') : t('error.generic') };
  }
  revalidatePath(userPath(userId));
  return { notice: t('notice.roleChanged'), savedAt: Date.now() };
}

export async function saveInstanceSettings(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const t = await getTranslations('admin.settings');
  const max = integer(formData, 'maxRunningSessionsPerUser');
  if (!Number.isInteger(max) || max < 1 || max > 1_000) {
    return { fields: { maxRunningSessionsPerUser: t('error.max') } };
  }
  let changed: string[];
  try {
    ({ changed } = await adminSaveSettings(deps(), await headers(), {
      requireTotp: checked(formData, 'requireTotp'),
      maxRunningSessionsPerUser: max,
      localShellVisible: checked(formData, 'localShellVisible'),
      fileTransferEnabled: checked(formData, 'fileTransferEnabled'),
      fileAuditEnabled: checked(formData, 'fileAuditEnabled'),
    }));
  } catch (err) {
    guard(err);
    return { message: t('error.generic') };
  }
  revalidatePath('/admin/settings');
  return {
    notice: changed.length > 0 ? t('saved') : t('unchanged'),
    savedAt: Date.now(),
  };
}
