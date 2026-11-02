/** A session note without its body, as the notes API lists it (plan D-58). */
export interface NoteMeta {
  id: string;
  title: string;
  /** Compare-and-swap counter: a change sends it as `If-Match` and gets the next one back. */
  revision: number;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** UTF-8 size of the body. */
  bytes: number;
}

export interface Note extends NoteMeta {
  /** Plain text. */
  body: string;
}
