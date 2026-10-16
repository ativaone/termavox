'use client';

import { flushSync } from 'react-dom';

/**
 * Applies a state change inside a view transition, so elements with a view-transition-name (the
 * followed session's light, a row changing group) move in one crisp step. Without the API or
 * under reduced motion, the change simply applies.
 */
export function withViewTransition(apply: () => void): void {
  if (
    typeof document === 'undefined' ||
    typeof document.startViewTransition !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    apply();
    return;
  }
  const transition = document.startViewTransition(() => flushSync(apply));
  // A transition skipped by a newer one (or a hidden page) still applies the change.
  transition.ready.catch(() => {});
}
