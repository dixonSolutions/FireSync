import { describe, expect, it } from 'vitest';
import {
  ADDRESS_SCHEMA_VERSION,
  addressAuthorityTime,
  formatAddressLabel,
  newAddressRecord,
  validateAddressRecord,
} from '../src/sync15/engines/addresses.ts';
import {
  isCardNumberReadable,
  maskCardNumber,
} from '../src/sync15/engines/creditcards.ts';

describe('addresses', () => {
  it('wraps fields in an entry with a schema version', () => {
    const record = newAddressRecord({ 'given-name': 'Ada', country: 'GB' }, 1000);
    expect(record.entry?.version).toBe(ADDRESS_SCHEMA_VERSION);
    expect(record.entry?.['given-name']).toBe('Ada');
    expect(validateAddressRecord(record)).toEqual([]);
  });

  it('rejects a record with no entry or no version', () => {
    expect(validateAddressRecord({ id: 'x' })).toContain('entry must be an object');
    expect(validateAddressRecord({ id: 'x', entry: {} })).toContain(
      'entry.version must be a number',
    );
  });

  it('accepts a tombstone', () => {
    expect(validateAddressRecord({ id: 'x', deleted: true })).toEqual([]);
  });

  it('preserves fields written by a newer Firefox', () => {
    const record = newAddressRecord({ 'given-name': 'Ada', 'future-field': 'keep me' });
    expect(record.entry?.['future-field']).toBe('keep me');
  });

  it('uses timeLastModified as the conflict authority', () => {
    const record = newAddressRecord({}, 5000);
    expect(addressAuthorityTime(record)).toBe(5000);
    expect(addressAuthorityTime({ id: 'x' })).toBe(0);
  });

  it('formats a one-line label for the picker', () => {
    expect(
      formatAddressLabel({
        version: 1,
        'given-name': 'Ada',
        'family-name': 'Lovelace',
        'street-address': '12 Analytical Way',
        'address-level2': 'London',
        'postal-code': 'E1 6AN',
      }),
    ).toBe('Ada Lovelace — 12 Analytical Way, London, E1 6AN');
  });

  it('falls back to a generic label for an empty entry', () => {
    expect(formatAddressLabel({ version: 1 })).toBe('Address');
  });
});

describe('credit cards', () => {
  it('knows when a card number is readable without the Firefox keystore', () => {
    expect(isCardNumberReadable({ id: 'x', entry: { version: 3, 'cc-number': '4242' } })).toBe(true);
    expect(
      isCardNumberReadable({ id: 'x', entry: { version: 3, 'cc-number-encrypted': 'blob' } }),
    ).toBe(false);
    expect(isCardNumberReadable({ id: 'x' })).toBe(false);
  });

  it('masks a number down to the last four digits', () => {
    expect(maskCardNumber('4242 4242 4242 4242')).toBe('•••• 4242');
    expect(maskCardNumber('12')).toBe('••••');
  });
});
