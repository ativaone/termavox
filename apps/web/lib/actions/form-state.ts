/** Result of a form Server Action, rendered by the form's client component. */
export interface FormState {
  /** Form-level message, already localized. */
  message?: string;
  /** Field-level messages keyed by input name, already localized. */
  fields?: Record<string, string>;
  /** Non-secret values echoed back so a failed submit keeps what the user typed. */
  values?: Record<string, string>;
}

export const EMPTY_FORM: FormState = {};

export interface QrCode {
  d: string;
  size: number;
}

/** The forced TOTP enrollment, one state per step. */
export type EnrollState =
  | { step: 'password'; message?: string; fields?: Record<string, string> }
  | {
      step: 'verify';
      qr: QrCode;
      secret: string;
      backupCodes: string[];
      message?: string;
      fields?: Record<string, string>;
    }
  | { step: 'done'; backupCodes: string[] };
