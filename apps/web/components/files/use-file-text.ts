'use client';

import type { FileNameProblem } from '@termdock/protocol/client';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { FileCode, fileErrorKey } from '../../lib/files/errors.ts';
import { formatSize } from '../../lib/files/format.ts';

const NAME_KEYS = {
  empty: 'empty',
  dot: 'dot',
  slash: 'slash',
  nul: 'nul',
  too_long: 'tooLong',
} as const satisfies Record<FileNameProblem, string>;

/**
 * The words for a file failure: the daemon's code (or the browser's own) as a sentence, with the
 * server's own (cleaned, capped) message for a generic SFTP failure.
 */
export function useFileErrorText(): (code: string, message?: string) => string {
  const t = useTranslations('files.error');
  return useCallback(
    (code: string, message?: string) => {
      const key = fileErrorKey(code);
      if (code === FileCode.FileOpFailed && message && message !== code) {
        return t('fileOpFailedDetail', { detail: message });
      }
      return t(key);
    },
    [t],
  );
}

/** Why a typed name cannot be used, in words (checked before anything is sent). */
export function useNameProblemText(): (problem: FileNameProblem | 'taken') => string {
  const t = useTranslations('files.name');
  return useCallback(
    (problem: FileNameProblem | 'taken') => t(problem === 'taken' ? 'taken' : NAME_KEYS[problem]),
    [t],
  );
}

/** Sizes in the UI's locale. */
export function useSizeText(): (bytes: number) => string {
  const locale = useLocale();
  return useCallback((bytes: number) => formatSize(bytes, locale), [locale]);
}
