'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { TransferQueue } from '../../lib/files/transfer-queue.ts';

/**
 * While uploads are queued or running, leaving or reloading the page asks first: an upload
 * stops with the page (downloads live in the browser's own list and go on).
 */
export function useTransferLeaveGuard(queue: TransferQueue): void {
  const uploading = useSyncExternalStore(
    queue.subscribe,
    () => queue.activeUploads() > 0,
    () => false,
  );
  useEffect(() => {
    if (!uploading) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only when a value is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [uploading]);
}
