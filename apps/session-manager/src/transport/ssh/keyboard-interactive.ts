import type { CredentialSecret } from '../../core/types.ts';

export interface KeyboardInteractivePrompt {
  text: string;
  echo: boolean;
}

/** A keyboard-interactive round the transport could not answer by itself (plan §5.10). */
export interface KeyboardInteractiveRequest {
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePrompt[];
}

export type KeyboardInteractiveAction =
  | { kind: 'auto'; answers: string[] }
  | { kind: 'relay' }
  | { kind: 'reject' };

/**
 * Decides how to answer one keyboard-interactive round. Exactly one prompt matching
 * /password/i with a stored password credential is answered automatically, at most once per
 * connection attempt (a second password prompt means the stored password was wrong: relay it
 * instead of looping). Everything else goes to the user when a relay exists, else fails.
 */
export function decideKeyboardInteractive(input: {
  prompts: readonly KeyboardInteractivePrompt[];
  credential: CredentialSecret | null;
  autoAnswered: boolean;
  canRelay: boolean;
}): KeyboardInteractiveAction {
  const { prompts, credential } = input;
  if (
    !input.autoAnswered &&
    credential?.kind === 'password' &&
    prompts.length === 1 &&
    /password/i.test(prompts[0]!.text)
  ) {
    return { kind: 'auto', answers: [credential.password] };
  }
  return input.canRelay ? { kind: 'relay' } : { kind: 'reject' };
}
