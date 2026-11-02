import { NotesStore } from './store.ts';

/**
 * The browser tab's one notes store (plan D-58): it outlives the workspace shell, so client-side
 * navigation away and back finds the drafts as they were and their saves keep running. It belongs
 * to one user: a sign-out is a client-side navigation (a Server Action's redirect), so the module
 * survives it, and the store is dropped on sign-out and whenever another user's shell mounts.
 * On the server, where modules are shared between requests, every call gets its own store.
 */
let shared: { owner: string; store: NotesStore; detach(): void } | null = null;

/** What the page's life means for a store: saves on the way out, and asking before leaving. */
export function attachPageEvents(
  store: NotesStore,
  page: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') store.flushAll();
  };
  const onPageHide = () => store.flushOnExit();
  const onOnline = () => store.online();
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older browsers show the prompt only when a value is set.
    event.returnValue = '';
  };
  // Only while something is unsaved: a standing listener would cost the back/forward cache.
  let guarding = false;
  const guard = () => {
    const unsaved = store.hasUnsaved();
    if (unsaved === guarding) return;
    guarding = unsaved;
    if (unsaved) page.addEventListener('beforeunload', onBeforeUnload);
    else page.removeEventListener('beforeunload', onBeforeUnload);
  };
  const unsubscribe = store.subscribe(guard);
  guard();
  page.addEventListener('pagehide', onPageHide);
  page.addEventListener('online', onOnline);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    unsubscribe();
    page.removeEventListener('beforeunload', onBeforeUnload);
    page.removeEventListener('pagehide', onPageHide);
    page.removeEventListener('online', onOnline);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/** The store of the signed-in user, its counts re-seeded from this first paint. */
export function sharedNotesStore(
  owner: string,
  counts: Readonly<Record<string, number>>,
): NotesStore {
  if (typeof window === 'undefined') return new NotesStore({ counts });
  if (shared?.owner === owner) {
    shared.store.seedCounts(counts);
    return shared.store;
  }
  discardSharedNotesStore();
  const store = new NotesStore({ counts });
  shared = { owner, store, detach: attachPageEvents(store, window, document) };
  return store;
}

/** Drops the store: its timers stop and its text is gone from memory. */
export function discardSharedNotesStore(): void {
  shared?.detach();
  shared?.store.dispose();
  shared = null;
}

/** Signing out: what can still go out goes, while the cookie is good, and the rest is dropped. */
export function leaveNotesOnSignOut(): void {
  shared?.store.flushOnExit();
  discardSharedNotesStore();
}
