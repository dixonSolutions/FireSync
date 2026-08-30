/**
 * The `addresses` collection — Firefox's autofill address book.
 *
 * Unlike `passwords`, address payloads wrap their fields in an `entry`
 * sub-object and carry a schema `version`. Firefox refuses records whose
 * version it does not understand, so FireSync writes version 1 and passes
 * unknown fields through untouched rather than dropping them: round-tripping a
 * record written by a newer Firefox must not destroy data.
 */

import { newRecordId } from '../../common/bytes.ts';

export const ADDRESSES_COLLECTION = 'addresses';
export const ADDRESS_SCHEMA_VERSION = 1;

export interface AddressEntry {
  version: number;
  'given-name'?: string;
  'additional-name'?: string;
  'family-name'?: string;
  organization?: string;
  'street-address'?: string;
  'address-level3'?: string;
  'address-level2'?: string;
  'address-level1'?: string;
  'postal-code'?: string;
  country?: string;
  tel?: string;
  email?: string;
  timeCreated?: number;
  timeLastModified?: number;
  timeLastUsed?: number;
  timesUsed?: number;
  [key: string]: unknown;
}

export interface AddressRecord {
  id: string;
  entry?: AddressEntry;
  deleted?: boolean;
}

/** The autocomplete tokens each address field can fill. */
export const ADDRESS_AUTOCOMPLETE_MAP: Record<string, keyof AddressEntry> = {
  'given-name': 'given-name',
  'additional-name': 'additional-name',
  'family-name': 'family-name',
  name: 'given-name',
  organization: 'organization',
  'street-address': 'street-address',
  'address-line1': 'street-address',
  'address-level2': 'address-level2',
  'address-level1': 'address-level1',
  'postal-code': 'postal-code',
  country: 'country',
  'country-name': 'country',
  tel: 'tel',
  email: 'email',
};

export function validateAddressRecord(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['record is not an object'];
  const record = value as Record<string, unknown>;
  if (record['deleted'] === true) {
    return typeof record['id'] === 'string' && record['id'] ? [] : ['tombstone is missing an id'];
  }
  const issues: string[] = [];
  if (typeof record['id'] !== 'string') issues.push('id must be a string');
  const entry = record['entry'];
  if (typeof entry !== 'object' || entry === null) {
    issues.push('entry must be an object');
  } else if (typeof (entry as AddressEntry).version !== 'number') {
    issues.push('entry.version must be a number');
  }
  return issues;
}

export function newAddressRecord(
  fields: Partial<AddressEntry>,
  now = Date.now(),
): AddressRecord {
  return {
    id: newRecordId(),
    entry: {
      ...fields,
      version: ADDRESS_SCHEMA_VERSION,
      timeCreated: now,
      timeLastModified: now,
      timeLastUsed: now,
      timesUsed: 1,
    },
  };
}

export function addressAuthorityTime(record: AddressRecord): number {
  return record.entry?.timeLastModified ?? record.entry?.timeCreated ?? 0;
}

/** A single-line label for the picker UI. */
export function formatAddressLabel(entry: AddressEntry): string {
  const name = [entry['given-name'], entry['family-name']].filter(Boolean).join(' ');
  const place = [entry['street-address'], entry['address-level2'], entry['postal-code']]
    .filter(Boolean)
    .join(', ');
  return [name, place].filter(Boolean).join(' — ') || 'Address';
}
