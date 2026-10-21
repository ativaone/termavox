'use client';

import '@xterm/xterm/css/xterm.css';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionFiles } from '../../lib/files/client.ts';
import { fileErrorCode, fileErrorKey } from '../../lib/files/errors.ts';
import { savePastedImage } from '../../lib/files/paste-image.ts';
import { PASTE_IMAGE_TYPES, pasteText } from '../../lib/terminal/paste.ts';
import { useTerminalChannel } from '../../lib/terminal/react.ts';
import { altChar, ctrlChar } from '../../lib/workspace/keys.ts';
import { cleanTitle } from '../../lib/workspace/title.ts';
import { filesAllowedFor } from '../files/files-toggle.tsx';
import { cx } from '../ui/cx.ts';
import { type LinkPrompt, PaneOverlays } from './pane-overlays.tsx';
import { type PanePlace, useWorkspace } from './workspace-context.tsx';

/** Viewport for a re-attach before the pane was measured (corrected by the next report). */
const FALLBACK_VIEWPORT = { cols: 80, rows: 24 };

/** Ctrl+Shift+K (⌘⇧K): the palette from inside a terminal, where Ctrl/⌘K belongs to the shell. */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyK'
  );
}

/** Decodes an OSC 52 payload (`Pc ; base64`) to text; null for queries and malformed data. */
function osc52Text(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const payload = data.slice(separator + 1);
  if (payload === '?' || payload.length > 1_000_000) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One terminal pane: an xterm mirroring `sessionId` over the tab's connection, inside a
 * container whose size comes from the layout alone (absolute, overflow hidden), so the viewport
 * it reports can never feed back into its own size. Focus is only moved here on an explicit
 * request (`focusRequest`): focusing makes this the session's active attachment and resizes the
 * session to this pane.
 */
export function TerminalPane({
  place,
  sessionId,
  active,
  dim = false,
  onClose,
}: {
  place: PanePlace;
  sessionId: string;
  /** The pane holds the focus in its tab. */
  active: boolean;
  /** Draw it slightly dimmed (an unfocused pane of a split). */
  dim?: boolean;
  onClose: (() => void) | null;
}) {
  const t = useTranslations('workspace.pane');
  const ws = useWorkspace();
  const { preferences } = ws;
  const containerRef = useRef<HTMLDivElement>(null);
  const [linkPrompt, setLinkPrompt] = useState<LinkPrompt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { paneId } = place;

  const confirmLinks = preferences.confirmLinks;
  const confirmLink = useCallback(
    (uri: string): boolean | Promise<boolean> => {
      if (!confirmLinks) return true;
      return new Promise<boolean>((resolve) => {
        setLinkPrompt((previous) => {
          previous?.resolve(false);
          return {
            uri,
            resolve: (open) => {
              setLinkPrompt(null);
              resolve(open);
            },
          };
        });
      });
    },
    [confirmLinks],
  );

  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const { setPaneMeta } = ws;
  const onTitle = useCallback(
    (title: string) => setPaneMeta(paneId, { title: cleanTitle(title) }),
    [setPaneMeta, paneId],
  );
  const onBell = useCallback(() => {
    if (!activeRef.current || !document.hasFocus()) setPaneMeta(paneId, { bell: true });
  }, [setPaneMeta, paneId]);

  // An image pasted without text goes to the session's server and its path is pasted (plan
  // D-48), through the file panel's upload: only where that panel is allowed.
  const tf = useTranslations('files');
  const { connection, transfers, filesEnabled, sessions } = ws;
  const filesAllowed = filesAllowedFor(filesEnabled, sessions.get(sessionId));
  const terminalRef = useRef<{ paste(text: string): void } | null>(null);
  const onImagePaste = useCallback(
    (image: File) => {
      const extension = PASTE_IMAGE_TYPES[image.type];
      if (!extension) return;
      if (!filesAllowed) {
        setNotice(t('imagePasteUnavailable'));
        return;
      }
      savePastedImage({
        files: sessionFiles(connection, sessionId),
        queue: transfers,
        sessionId,
        image,
        extension,
      }).then(
        (path) => {
          if (terminalRef.current) pasteText(terminalRef.current, path);
        },
        (err: unknown) =>
          setNotice(
            t('imagePasteFailed', { reason: tf(`error.${fileErrorKey(fileErrorCode(err))}`) }),
          ),
      );
    },
    [filesAllowed, connection, transfers, sessionId, t, tf],
  );

  const { state, layout, channel, terminal, error } = useTerminalChannel(
    ws.appearance ? ws.connection : null,
    sessionId,
    containerRef,
    {
      appearance: ws.appearance ?? undefined,
      confirmLink,
      onTitle,
      onBell,
      onImagePaste,
    },
  );
  useEffect(() => {
    terminalRef.current = terminal;
  }, [terminal]);

  // Cursor style and blink: the user's initial values (the stream may change them later, and a
  // snapshot restores what it set).
  const { cursorStyle, cursorBlink } = preferences;
  useEffect(() => {
    if (!terminal) return;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorBlink = cursorBlink;
  }, [terminal, cursorStyle, cursorBlink]);

  // Keyboard: the palette shortcut never reaches the shell, and the sticky modifiers from the
  // phone key bar apply to the next key: Ctrl masks a printable key into its control byte, Alt
  // sends the key behind an ESC prefix (both: the masked byte behind ESC).
  const { ctrlArmed, consumeCtrl, altArmed, consumeAlt } = ws;
  useEffect(() => {
    if (!terminal || !channel) return;
    const armed = (key: string): string | null => {
      if (!ctrlArmed.current && !altArmed.current) return null;
      const base = ctrlArmed.current ? ctrlChar(key) : key.length === 1 ? key : null;
      if (base === null) return null;
      return altArmed.current ? altChar(base) : base;
    };
    const consume = () => {
      if (ctrlArmed.current) consumeCtrl();
      if (altArmed.current) consumeAlt();
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (isPaletteShortcut(event)) return false;
      if (event.type === 'keydown' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const bytes = armed(event.key);
        if (bytes) {
          event.preventDefault();
          channel.input(bytes);
          consume();
          return false;
        }
      }
      return true;
    });
    // Soft keyboards often report keydown as "Unidentified" and deliver text as input events.
    const textarea = terminal.textarea;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== 'insertText' || !event.data) return;
      const bytes = armed(event.data);
      if (!bytes) return;
      event.preventDefault();
      channel.input(bytes);
      consume();
    };
    textarea?.addEventListener('beforeinput', onBeforeInput, true);
    return () => {
      terminal.attachCustomKeyEventHandler(() => true);
      textarea?.removeEventListener('beforeinput', onBeforeInput, true);
    };
  }, [terminal, channel, ctrlArmed, consumeCtrl, altArmed, consumeAlt]);

  // Clipboard preferences: copy on select, right-click paste, OSC 52 writes (opt-in).
  const { copyOnSelect, rightClickPaste, allowOsc52Write } = preferences;
  const clipboardDenied = t('clipboardDenied');
  useEffect(() => {
    if (!terminal || !copyOnSelect) return;
    const subscription = terminal.onSelectionChange(() => {
      const text = terminal.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    });
    return () => subscription.dispose();
  }, [terminal, copyOnSelect]);
  useEffect(() => {
    const container = containerRef.current;
    if (!terminal || !container || !rightClickPaste) return;
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (!navigator.clipboard?.readText) {
        setNotice(clipboardDenied);
        return;
      }
      navigator.clipboard.readText().then(
        (text) => pasteText(terminal, text),
        () => setNotice(clipboardDenied),
      );
    };
    container.addEventListener('contextmenu', onContextMenu);
    return () => container.removeEventListener('contextmenu', onContextMenu);
  }, [terminal, rightClickPaste, clipboardDenied]);
  useEffect(() => {
    if (!terminal || !allowOsc52Write) return;
    // Registered after the query silencer, so it runs first: queries fall through to it.
    const handler = terminal.parser.registerOscHandler(52, (data) => {
      const text = osc52Text(data);
      if (text === null) return false;
      void navigator.clipboard?.writeText(text).catch(() => {});
      return true;
    });
    return () => handler.dispose();
  }, [terminal, allowOsc52Write]);

  // The shell reaches the terminal through this handle (key bar, palette viewport).
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  const { registerPane } = ws;
  useEffect(() => {
    if (!terminal || !channel) return;
    registerPane(paneId, {
      terminal,
      channel,
      viewport: () => layoutRef.current?.viewport ?? null,
    });
    return () => registerPane(paneId, null);
  }, [registerPane, paneId, terminal, channel]);

  // Explicit focus requests only (never on mount: that would take the session's size).
  const handled = useRef(0);
  const request = ws.focusRequest;
  useEffect(() => {
    if (!terminal || !request || request.paneId !== paneId || handled.current === request.seq) {
      return;
    }
    handled.current = request.seq;
    terminal.focus();
  }, [terminal, request, paneId]);

  // After a link decision, the keyboard goes back to the terminal it came from.
  const hadLink = useRef(false);
  useEffect(() => {
    if (linkPrompt) hadLink.current = true;
    else if (hadLink.current) {
      hadLink.current = false;
      terminal?.focus();
    }
  }, [linkPrompt, terminal]);

  // A pane that unmounts with a pending link confirmation declines it.
  const pendingLink = useRef(linkPrompt);
  useEffect(() => {
    pendingLink.current = linkPrompt;
  }, [linkPrompt]);
  useEffect(() => () => pendingLink.current?.resolve(false), []);

  const { onPaneFocus } = ws;
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: ws.appearance?.theme?.background }}
      onFocusCapture={() => onPaneFocus(place)}
    >
      <div
        className={cx(
          'absolute inset-y-1 start-2 end-0 overflow-hidden transition-[filter] duration-(--duration-step) ease-(--ease-out)',
          dim && 'brightness-[0.78] saturate-[0.85]',
        )}
      >
        <div ref={containerRef} data-terminal="" className="absolute inset-0 overflow-hidden" />
      </div>
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <p className="max-w-[28rem] text-center text-ink-muted text-sm">{t('tooMany')}</p>
        </div>
      ) : (
        <PaneOverlays
          sessionId={sessionId}
          channelState={state}
          layout={layout}
          active={active}
          linkPrompt={linkPrompt}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onRetryAttach={
            channel
              ? () => channel.attach(sessionId, layoutRef.current?.viewport ?? FALLBACK_VIEWPORT)
              : null
          }
          onClose={onClose}
        />
      )}
    </div>
  );
}
