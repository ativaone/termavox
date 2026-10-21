'use client';

import type { Terminal } from '@xterm/xterm';
import { createContext, type RefObject, useContext } from 'react';
import type { PaneFilesStore } from '../../lib/files/pane-state.ts';
import type { TransferQueue } from '../../lib/files/transfer-queue.ts';
import type { TerminalPreferences } from '../../lib/preferences/terminal.ts';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import type { SessionLabel } from '../../lib/sessions/types.ts';
import type {
  ConnectionState,
  Dimensions,
  SessionEntry,
  TermavoxConnection,
  TerminalChannel,
} from '../../lib/terminal/index.ts';
import type { TerminalAppearance } from '../../lib/terminal/xterm.ts';

/** What the shell can do with a mounted terminal pane. */
export interface PaneHandle {
  terminal: Terminal;
  channel: TerminalChannel;
  /** The fitted grid of the pane (null before the font is measured). */
  viewport(): Dimensions | null;
}

/** Runtime facts about a pane that are not part of the saved layout. */
export interface PaneMeta {
  /** Last OSC title (sanitized). */
  title: string | null;
  /** The bell rang while the pane was not in front of you. */
  bell: boolean;
}

/** A pane's terminal rang its bell. */
export interface PaneBell {
  paneId: string;
  sessionId: string;
  /** The pane is the active one (its tab's focused pane; the phone's single pane). */
  active: boolean;
}

export type SessionActionKind = 'retry' | 'stop' | 'reopen' | 'terminate' | 'remove';

/** Where a pane sits: in a tab of the saved layout, or the phone's single pane (`tabId` null). */
export interface PanePlace {
  tabId: string | null;
  paneId: string;
}

export interface WorkspaceContextValue {
  connection: TermavoxConnection;
  connectionState: ConnectionState;
  sessions: ReadonlyMap<string, SessionEntry>;
  /** Label and status per session, from the server-rendered bay until live data arrives. */
  labels: ReadonlyMap<string, SessionLabel>;
  preferences: TerminalPreferences;
  /** Null until the terminal font has loaded (terminals wait for it). */
  appearance: TerminalAppearance | null;
  isDesktop: boolean;
  /** Bumped when a pane should take the keyboard (an explicit "open" or "go to"). */
  focusRequest: { paneId: string; seq: number } | null;
  /** Sticky Ctrl from the phone key bar: the next printable key becomes its control byte. */
  ctrlArmed: RefObject<boolean>;
  consumeCtrl(): void;
  /** Sticky Alt from the phone key bar: the next key goes out behind an ESC prefix (D-17). */
  altArmed: RefObject<boolean>;
  consumeAlt(): void;
  registerPane(paneId: string, handle: PaneHandle | null): void;
  /** Focus moved into a pane: it becomes the tab's active pane. */
  onPaneFocus(place: PanePlace): void;
  setPaneMeta(paneId: string, patch: Partial<PaneMeta>): void;
  /**
   * The bell rang in a mounted pane (`terminal.bell`): its tab mark and the window title follow.
   * Background tabs and desktop notifications follow the daemon's `session.bell` (any tab).
   */
  ringBell(bell: PaneBell): void;
  closePane(place: PanePlace): void;
  bindPane(place: PanePlace, sessionId: string): void;
  openPalette(target?: PanePlace): void;
  sessionAction(kind: SessionActionKind, sessionId: string): Promise<SessionActionResult>;
  /** A server's page (the mismatch panel links there). */
  serverHref(serverId: string): string;
  /** File transfer is on for this installation (plan D-39): the file panel's toggles show. */
  filesEnabled: boolean;
  /** Each pane's file panel state, in this tab's memory only. */
  filePanes: PaneFilesStore;
  /** The tab's uploads and downloads (they outlive panels and panes). */
  transfers: TransferQueue;
  /** Gives the keyboard to a pane's terminal (after its file panel closes). */
  focusPane(paneId: string): void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace outside the workspace shell');
  return value;
}
