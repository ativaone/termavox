import '../server-guard.ts';

/** Something the user must complete before anything else opens (plan §8.1, §10.2). */
export type AuthRequirement = 'password-change' | 'totp-enrollment';

export interface RequirementUser {
  mustChangePassword?: boolean | null;
  totpRequired?: boolean | null;
  twoFactorEnabled?: boolean | null;
}

export interface BanUser {
  banned?: boolean | null;
  banExpires?: Date | string | number | null;
}

/** Whether TOTP is mandatory for this user (per-user flag or the instance-wide setting). */
export function totpRequiredFor(user: RequirementUser, instanceRequiresTotp: boolean): boolean {
  return instanceRequiresTotp || user.totpRequired === true;
}

/** The first pending requirement, password change first. */
export function pendingRequirement(
  user: RequirementUser,
  instanceRequiresTotp: boolean,
): AuthRequirement | null {
  if (user.mustChangePassword === true) return 'password-change';
  if (totpRequiredFor(user, instanceRequiresTotp) && user.twoFactorEnabled !== true) {
    return 'totp-enrollment';
  }
  return null;
}

/** Disabled account (admin plugin `banned`), honouring `banExpires` like session-manager does. */
export function isBanned(user: BanUser, now: number = Date.now()): boolean {
  if (user.banned !== true) return false;
  if (user.banExpires == null) return true;
  return new Date(user.banExpires).getTime() > now;
}
