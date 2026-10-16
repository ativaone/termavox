'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useSyncExternalStore } from 'react';
import { PlusIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { Kbd } from '../ui/kbd.tsx';

/** Window event the session palette (next workstream) listens for. */
export const NEW_SESSION_EVENT = 'termdock:new-session';

const noSubscribe = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);

function requestNewSession() {
  window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT));
}

/**
 * "New session" with its Ctrl/⌘K hint. Publishes the request as a window event; Ctrl/⌘K does
 * the same unless focus is inside a terminal (`[data-terminal]`), which owns every key.
 */
export function NewSessionButton({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations('workspace.bay');
  const apple = useSyncExternalStore(noSubscribe, isApplePlatform, () => false);

  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || event.shiftKey || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof Element && event.target.closest('[data-terminal]')) return;
      event.preventDefault();
      requestNewSession();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled]);

  return (
    <Button
      variant="primary"
      block
      disabled={disabled}
      onClick={requestNewSession}
      icon={<PlusIcon size={16} />}
      aria-keyshortcuts={apple ? 'Meta+K' : 'Control+K'}
    >
      <span className="flex-1 text-start">{t('newSession')}</span>
      <span className="flex items-center gap-0.5 max-md:hidden" title={t('shortcut')}>
        <Kbd tone="inherit">{apple ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd tone="inherit">K</Kbd>
      </span>
    </Button>
  );
}
