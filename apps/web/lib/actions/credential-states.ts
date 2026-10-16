import type { ManageState } from '../manage/forms.ts';

export type CredentialKind = 'password' | 'private_key' | 'generate';

/** Result of creating a credential. The public key of a generated key is shown once. */
export interface CredentialCreateState extends ManageState {
  created?: {
    name: string;
    kind: CredentialKind;
    publicKey: string | null;
    fingerprint: string | null;
  };
}
