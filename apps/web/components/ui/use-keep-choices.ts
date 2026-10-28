'use client';

import { type RefObject, useEffect } from 'react';

/**
 * React resets a form once its action has run (React 19). A controlled radio or select then goes
 * back to what it showed when it mounted while React still believes it shows its current value,
 * so the page showed one choice and the next submit sent another (a credential refused for a
 * missing password went back to "Generate key"; terminal settings went back to the scheme and
 * font they loaded with). This takes over the form's reset: text fields, checkboxes and file
 * fields reset as usual, radios and selects keep what React last rendered.
 */
export function useKeepChoicesOnReset(form: RefObject<HTMLFormElement | null>): void {
  useEffect(() => {
    const node = form.current;
    if (!node) return;
    const reset = (event: Event) => {
      event.preventDefault();
      for (const element of node.elements) {
        if (element instanceof HTMLTextAreaElement) {
          element.value = element.defaultValue;
        } else if (element instanceof HTMLInputElement) {
          if (element.type === 'radio') continue;
          if (element.type === 'checkbox') element.checked = element.defaultChecked;
          else if (element.type === 'file') element.value = '';
          else element.value = element.defaultValue;
        }
      }
    };
    node.addEventListener('reset', reset);
    return () => node.removeEventListener('reset', reset);
  }, [form]);
}
