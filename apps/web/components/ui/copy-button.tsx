'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from '../icons/index.tsx';
import { Button, type ButtonSize, type ButtonVariant } from './button.tsx';

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies `value` to the clipboard and says so (politely announced), then resets. */
export function CopyButton({
  value,
  label,
  variant = 'secondary',
  size = 'sm',
}: {
  value: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const t = useTranslations('common.copy');
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2400);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        size={size}
        onClick={copy}
        icon={state === 'copied' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      >
        {state === 'copied' ? t('copied') : (label ?? t('copy'))}
      </Button>
      <span role="status" className={state === 'failed' ? 'text-danger text-sm' : 'sr-only'}>
        {state === 'failed' ? t('failed') : state === 'copied' ? t('copied') : ''}
      </span>
    </span>
  );
}
