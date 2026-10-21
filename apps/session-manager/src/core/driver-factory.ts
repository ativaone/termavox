import type { TmuxTerm } from '@termavox/protocol';
import { RawPtyDriver } from '../drivers/raw-pty/raw-pty-driver.ts';
import type { ProbeResult } from '../probe/index.ts';
import type { Driver, RemoteIdentity } from './types.ts';

/** Constructor options of `TmuxControlDriver` (src/drivers/tmux-control, built separately). */
export interface TmuxControlDriverOptions {
  probe: ProbeResult;
  /** Per-session tmux socket name (plan §6.3). */
  socket: string;
  scrollbackLines: number;
  /** The session's terminal type inside tmux (plan D-49). */
  tmuxTerm: TmuxTerm;
  startupCommand: string | null;
  env: Record<string, string>;
  previousIdentity: RemoteIdentity | null;
  /** `created`: the launch created the tmux session (nothing to attach to was there). */
  onIdentity(identity: RemoteIdentity, rebooted: boolean, created?: boolean): void;
  pauseAfterSeconds?: number;
}

export interface RawPtyDriverOptions {
  term: string;
  env: Record<string, string>;
  /** Typed into the new shell once it opens (followed by Enter); null for none. */
  startupCommand: string | null;
}

/** Builds drivers for the runtime. tmux-control is wired by the boot code (main.ts). */
export interface DriverFactory {
  rawPty(opts: RawPtyDriverOptions): Driver;
  /** Absent until the tmux-control driver is wired: sessions then run unprotected. */
  tmuxControl?: (opts: TmuxControlDriverOptions) => Driver;
}

export function createDriverFactory(
  tmuxControl?: (opts: TmuxControlDriverOptions) => Driver,
): DriverFactory {
  const factory: DriverFactory = { rawPty: (opts) => new RawPtyDriver(opts) };
  if (tmuxControl) factory.tmuxControl = tmuxControl;
  return factory;
}

/**
 * This installation's part of every tmux socket name: the installation id lowercased, without
 * anything outside [a-z0-9], cut to 8 characters (plan §6.3). The one place that computes it:
 * socket names and the remote leftover classification (plan D-30) both come from here.
 */
export function tmuxSocketPrefix(installationId: string): string {
  return installationId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
}

/** Socket name `tv-<installationId[0:8]>-<tmuxToken>` (plan §6.3; [a-z0-9-] only). */
export function tmuxSocketName(installationId: string, tmuxToken: string): string {
  return `tv-${tmuxSocketPrefix(installationId)}-${tmuxToken}`;
}
