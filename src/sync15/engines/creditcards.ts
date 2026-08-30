/**
 * The `creditcards` collection — deliberately read-only and feature-flagged
 * OFF by default.
 *
 * Firefox additionally protects the card number with an OS keystore locally,
 * and the payload schema has changed more than once. Until a real account has
 * been observed round-tripping (see docs/TESTING.md#credit-cards), FireSync
 * will surface cards it can decrypt but will never write to this collection.
 * Writing a record Firefox cannot read back is how you lose a user's payment
 * data, and there is no undo.
 */

export const CREDITCARDS_COLLECTION = 'creditcards';

export interface CreditCardEntry {
  version: number;
  'cc-name'?: string;
  'cc-given-name'?: string;
  'cc-family-name'?: string;
  'cc-number'?: string;
  'cc-number-encrypted'?: string;
  'cc-exp-month'?: number;
  'cc-exp-year'?: number;
  'cc-type'?: string;
  timeCreated?: number;
  timeLastModified?: number;
  [key: string]: unknown;
}

export interface CreditCardRecord {
  id: string;
  entry?: CreditCardEntry;
  deleted?: boolean;
}

/** Whether this record's number is readable without the Firefox OS keystore. */
export function isCardNumberReadable(record: CreditCardRecord): boolean {
  const entry = record.entry;
  if (!entry) return false;
  return typeof entry['cc-number'] === 'string' && entry['cc-number'].length > 0;
}

/** `•••• 4242` style masking for the picker; never show a full PAN in a list. */
export function maskCardNumber(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}
