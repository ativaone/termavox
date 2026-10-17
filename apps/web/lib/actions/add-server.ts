'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getAuthRuntime, requireSession } from '../auth/server.ts';
import { getInternalApi } from '../internal-api.ts';
import { text } from '../manage/forms.ts';
import { getInstanceSettings } from '../repo/instance-settings.ts';
import { ROUTES } from '../routes.ts';
import { type AddServerMessage, addServerCore, type Issue } from './add-server-core.ts';
import {
  ADD_SERVER_VIEWPORT,
  type AddServerState,
  type StartSessionState,
} from './add-server-states.ts';
import { createSession } from './sessions.ts';

/**
 * "Add server" (plan D-27): one form creates whatever is missing at once (a credential, the host
 * when new, and always a new connection profile) and shows the result in place, with the public
 * key of a generated key and a "Start a session" button. The work lives in add-server-core.ts.
 */
export async function addServer(
  _prev: AddServerState,
  formData: FormData,
): Promise<AddServerState> {
  const { user } = await requireSession();
  const { db, logger } = getAuthRuntime();
  const outcome = await addServerCore(
    {
      db,
      user,
      api: getInternalApi,
      localShellVisible: getInstanceSettings(db).localShellVisible,
      logger,
    },
    formData,
  );
  if (outcome.ok) {
    revalidatePath(ROUTES.hosts);
    revalidatePath(ROUTES.credentials);
    revalidatePath(ROUTES.workspace);
    return { created: outcome.created };
  }
  const [th, tp, tc, ta] = await Promise.all([
    getTranslations('hosts.error'),
    getTranslations('hosts.profile.error'),
    getTranslations('credentials.error'),
    getTranslations('hosts.addServer.error'),
  ]);
  const localize = (issue: Issue): string => {
    switch (issue.scope) {
      case 'host':
        return th(issue.key);
      case 'profile':
        return tp(issue.key);
      case 'credential':
        return tc(issue.key);
      case 'addServer':
        return ta(issue.key);
    }
  };
  const message = (m: AddServerMessage): string =>
    m.key === 'leftover' ? ta('leftover', { name: m.name }) : ta(m.key);
  return {
    ...(outcome.fields
      ? {
          fields: Object.fromEntries(
            Object.entries(outcome.fields).map(([field, issue]) => [field, localize(issue)]),
          ),
        }
      : {}),
    ...(outcome.message ? { message: message(outcome.message) } : {}),
    values: outcome.values,
  };
}

/**
 * "Start a session" on the success state: opens a session from the new profile through the same
 * path as the workspace (internal API, as the signed-in user), then shows it in the workspace's
 * focused pane. The first connection goes through the normal host-key trust flow there.
 */
export async function startAddedServerSession(
  _prev: StartSessionState,
  formData: FormData,
): Promise<StartSessionState> {
  const result = await createSession({
    profileId: text(formData, 'profileId'),
    viewport: { ...ADD_SERVER_VIEWPORT },
  });
  if (!result.ok) return { message: result.message };
  if (!result.sessionId) {
    const t = await getTranslations('manage.sessionError');
    return { message: t('generic') };
  }
  redirect(`${ROUTES.workspace}?open=${encodeURIComponent(result.sessionId)}`);
}
