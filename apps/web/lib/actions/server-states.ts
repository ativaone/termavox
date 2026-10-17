import type { ServerTestResult } from '../internal-api.ts';
import type { ManageState } from '../manage/forms.ts';
import type { ProbeSummary } from '../manage/probe.ts';

/** The Docker host preset's address (plan §13.4; compose maps it to the host gateway). */
export const DOCKER_HOSTNAME = 'host.docker.internal';

/** Result of "Test connection" on the server page. */
export interface DiagnosticsState {
  message?: string;
  at?: number;
  result?: {
    reachable: boolean;
    /** Daemon error code (HOST_UNREACHABLE, HOST_KEY_MISMATCH, AUTH_REJECTED, …) or null. */
    error: string | null;
    hostKey: ServerTestResult['hostKey'];
    probe: ProbeSummary | null;
    /** The presented key is one the owner revoked for this address (error: HOST_KEY_MISMATCH). */
    revoked?: boolean;
  };
}

/** Result of "Add this Docker host": the public key is shown once, with the install command. */
export interface DockerPresetState extends ManageState {
  created?: { serverId: string; publicKey: string; fingerprint: string | null; username: string };
}
