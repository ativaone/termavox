'use client';

import type { Terminal } from '@xterm/xterm';
import { createContext, type RefObject, useContext } from 'react';
import type { TerminalPreferences } from '../../lib/preferences/terminal.ts';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import type {
  ConnectionState,
  Dimensions,
  SessionEntry,
  TermdockConnection,
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

export type SessionActionKind = 'retry' | 'reopen' | 'terminate';

/** Where a pane sits: in a tab of the saved layout, or the phone's single pane (`tabId` null). */
export interface PanePlace {
  tabId: string | null;
  paneId: string;
}

export interface WorkspaceContextValue {
  connection: TermdockConnection;
  connectionState: ConnectionState;
  sessions: ReadonlyMap<string, SessionEntry>;
  preferences: TerminalPreferences;
  /** Null until the terminal font has loaded (terminals wait for it). */
  appearance: TerminalAppearance | null;
  isDesktop: boolean;
  /** Bumped when a pane should take the keyboard (an explicit "open" or "go to"). */
  focusRequest: { paneId: string; seq: number } | null;
  /** Sticky Ctrl from the phone key bar: the next printable key becomes its control byte. */
  ctrlArmed: RefObject<boolean>;
  consumeCtrl(): void;
  registerPane(paneId: string, handle: PaneHandle | null): void;
  /** Focus moved into a pane: it becomes the tab's active pane. */
  onPaneFocus(place: PanePlace): void;
  setPaneMeta(paneId: string, patch: Partial<PaneMeta>): void;
  closePane(place: PanePlace): void;
  bindPane(place: PanePlace, sessionId: string): void;
  openPalette(target?: PanePlace): void;
  sessionAction(kind: SessionActionKind, sessionId: string): Promise<SessionActionResult>;
  hostHref(hostId: string): string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace outside the workspace shell');
  return value;
}
