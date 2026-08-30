import { describe, expect, it } from 'vitest';
import {
  changePassword,
  isValidPasswordRecord,
  markPasswordUsed,
  newPasswordRecord,
  normalizeOrigin,
  passwordAuthorityTime,
  passwordTombstone,
  validatePasswordRecord,
} from '../src/sync15/engines/passwords.ts';

describe('newPasswordRecord', () => {
  it('produces a record Firefox will accept', () => {
    const record = newPasswordRecord({
      origin: 'https://example.com/login?next=/home',
      username: 'ada',
      password: 'hunter2',
      usernameField: 'email',
      passwordField: 'pass',
      now: 1_700_000_000_000,
    });

    expect(validatePasswordRecord(record)).toEqual([]);
    expect(record.hostname).toBe('https://example.com');
    expect(record.formSubmitURL).toBe('https://example.com');
    expect(record.httpRealm).toBeNull();
    expect(record.timeCreated).toBe(1_700_000_000_000);
    expect(record.timesUsed).toBe(1);
    expect(record.id).toHaveLength(16);
  });

  it('creates an HTTP-auth record when a realm is supplied', () => {
    const record = newPasswordRecord({
      origin: 'https://intranet.example.com',
      username: 'ada',
      password: 'hunter2',
      httpRealm: 'Restricted',
    });
    expect(record.httpRealm).toBe('Restricted');
    expect(record.formSubmitURL).toBeNull();
    expect(validatePasswordRecord(record)).toEqual([]);
  });

  it('uses a distinct form action origin when one is given', () => {
    const record = newPasswordRecord({
      origin: 'https://example.com',
      formActionOrigin: 'https://auth.example.com/session',
      username: 'ada',
      password: 'hunter2',
    });
    expect(record.formSubmitURL).toBe('https://auth.example.com');
  });

  it('mints unique ids', () => {
    const ids = new Set(
      Array.from({ length: 100 }, () =>
        newPasswordRecord({ origin: 'https://a.test', username: 'u', password: 'p' }).id,
      ),
    );
    expect(ids.size).toBe(100);
  });
});

describe('validatePasswordRecord', () => {
  const base = newPasswordRecord({
    origin: 'https://example.com',
    username: 'ada',
    password: 'hunter2',
  });

  it('rejects a record with neither formSubmitURL nor httpRealm', () => {
    const issues = validatePasswordRecord({ ...base, formSubmitURL: null, httpRealm: null });
    expect(issues.map((issue) => issue.field)).toContain('formSubmitURL/httpRealm');
  });

  it('rejects a record with both set', () => {
    const issues = validatePasswordRecord({ ...base, httpRealm: 'Restricted' });
    expect(issues[0]?.message).toMatch(/not both/);
  });

  it('rejects a hostname carrying a path or query', () => {
    const issues = validatePasswordRecord({ ...base, hostname: 'https://example.com/login' });
    expect(issues.map((issue) => issue.message)).toContain('hostname must be a bare origin');
  });

  it('rejects a hostname that is not a URL', () => {
    const issues = validatePasswordRecord({ ...base, hostname: 'example.com' });
    expect(issues.some((issue) => issue.message.includes('not a valid origin'))).toBe(true);
  });

  it('requires the core string fields', () => {
    const issues = validatePasswordRecord({ ...base, username: undefined });
    expect(issues.map((issue) => issue.field)).toContain('username');
  });

  it('accepts a tombstone with only an id', () => {
    expect(validatePasswordRecord(passwordTombstone('abc123'))).toEqual([]);
  });

  it('rejects a tombstone with no id', () => {
    expect(validatePasswordRecord({ deleted: true })).toHaveLength(1);
  });

  it('rejects non-objects', () => {
    expect(isValidPasswordRecord('nope')).toBe(false);
    expect(isValidPasswordRecord(null)).toBe(false);
  });
});

describe('timestamps', () => {
  const record = newPasswordRecord({
    origin: 'https://example.com',
    username: 'ada',
    password: 'hunter2',
    now: 1000,
  });

  it('uses timePasswordChanged as the conflict authority', () => {
    expect(passwordAuthorityTime({ ...record, timePasswordChanged: 5000 })).toBe(5000);
  });

  it('falls back down the chain for records from older clients', () => {
    expect(
      passwordAuthorityTime({ ...record, timePasswordChanged: undefined, timeCreated: 42 }),
    ).toBe(42);
    expect(
      passwordAuthorityTime({
        ...record,
        timePasswordChanged: undefined,
        timeCreated: undefined,
        timeLastUsed: 7,
      }),
    ).toBe(7);
  });

  it('changePassword moves the authority forward', () => {
    const changed = changePassword(record, 'new-secret', 9999);
    expect(changed.password).toBe('new-secret');
    expect(passwordAuthorityTime(changed)).toBe(9999);
  });

  it('markPasswordUsed does NOT move the authority forward', () => {
    const used = markPasswordUsed(record, 9999);
    expect(used.timesUsed).toBe(2);
    expect(used.timeLastUsed).toBe(9999);
    expect(passwordAuthorityTime(used)).toBe(passwordAuthorityTime(record));
  });
});

describe('normalizeOrigin', () => {
  it('strips path, query, default port and case', () => {
    expect(normalizeOrigin('https://Example.COM:443/login?a=1#x')).toBe('https://example.com');
  });

  it('keeps a non-default port', () => {
    expect(normalizeOrigin('http://localhost:3000/app')).toBe('http://localhost:3000');
  });

  it('passes through anything it cannot parse', () => {
    expect(normalizeOrigin('not a url')).toBe('not a url');
  });
});
