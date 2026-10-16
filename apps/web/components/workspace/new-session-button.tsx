'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useSyncExternalStore } from 'react';
import { PlusIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { Kbd } from '../ui/kbd.tsx';

/** Window event the session palette listens for. */
export const NEW_SESSION_EVENT = 'termdock:new-session';

const noSubscribe = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);

function requestNewSession() {
  window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT));
}

/**
 * "New session" with its Ctrl/⌘K hint. Publishes the request as a window event; Ctrl/⌘K does
 * the same unless focus is inside a terminal (`[data-terminal]`), which owns every key.
 * Only the sidebar's instance listens for the shortcut; others (an empty pane's) pass
 * `shortcut={false}` so one key press never opens the palette twice. `compact` is the rail's
 * round icon button, named by its tooltip and accessible name.
 */
export function NewSessionButton({
  disabled = false,
  shortcut = true,
  block = true,
  compact = false,
}: {
  disabled?: boolean;
  shortcut?: boolean;
  block?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations('workspace.bay');
  const apple = useSyncExternalStore(noSubscribe, isApplePlatform, () => false);

  useEffect(() => {
    if (disabled || !shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || event.shiftKey || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof Element && event.target.closest('[data-terminal]')) return;
      event.preventDefault();
      requestNewSession();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, shortcut]);

  const keys = apple ? 'Meta+K' : 'Control+K';
  if (compact) {
    return (
      <Button
        variant="primary"
        iconOnly
        disabled={disabled}
        onClick={requestNewSession}
        aria-label={t('newSession')}
        title={`${t('newSession')} (${apple ? '⌘K' : 'Ctrl+K'})`}
        aria-keyshortcuts={keys}
        icon={<PlusIcon size={18} />}
        className="rounded-pill"
      />
    );
  }

  return (
    <Button
      variant="primary"
      size="lg"
      block={block}
      disabled={disabled}
      onClick={requestNewSession}
      icon={<PlusIcon size={16} />}
      aria-keyshortcuts={keys}
      className="h-10"
    >
      <span className={block ? 'flex-1 text-start' : undefined}>{t('newSession')}</span>
      <span
        className={`flex items-center gap-0.5 max-md:hidden${block ? '' : ' ms-2'}`}
        title={t('shortcut')}
      >
        <Kbd tone="inherit">{apple ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd tone="inherit">K</Kbd>
      </span>
    </Button>
  );
}
