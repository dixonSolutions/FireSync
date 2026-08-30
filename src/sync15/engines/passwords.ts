/**
 * The `passwords` collection.
 *
 * Payload shape, as written by Firefox Desktop, Android and iOS:
 *
 *   {
 *     "id":                  "<12-byte base64url>",
 *     "hostname":            "https://example.com",
 *     "formSubmitURL":       "https://example.com" | null,
 *     "httpRealm":           null | "realm",
 *     "username":            "user",
 *     "password":            "hunter2",
 *     "usernameField":       "email",
 *     "passwordField":       "pass",
 *     "timeCreated":         1735689600000,
 *     "timePasswordChanged": 1735689600000,
 *     "timeLastUsed":        1735689600000,
 *     "timesUsed":           3
 *   }
 *
 * Firefox enforces one invariant that FireSync must respect or the record will
 * be rejected/ignored on the Firefox side: **exactly one** of `formSubmitURL`
 * and `httpRealm` is non-null. Form logins set the former, HTTP-auth logins the
 * latter.
 */

import { newRecordId } from '../../common/bytes.ts';

export const PASSWORDS_COLLECTION = 'passwords';

export interface PasswordRecord {
  id: string;
  hostname: string;
  formSubmitURL?: string | null;
  httpRealm?: string | null;
  username: string;
  password: string;
  usernameField?: string;
  passwordField?: string;
  timeCreated?: number;
  timePasswordChanged?: number;
  timeLastUsed?: number;
  timesUsed?: number;
  /** Present on tombstones instead of everything above. */
  deleted?: boolean;
}

export interface PasswordValidationIssue {
  field: string;
  message: string;
}

/** Structural validation of a decrypted `passwords` payload. */
export function validatePasswordRecord(value: unknown): PasswordValidationIssue[] {
  const issues: PasswordValidationIssue[] = [];
  if (typeof value !== 'object' || value === null) {
    return [{ field: '.', message: 'record is not an object' }];
  }
  const record = value as Record<string, unknown>;

  if (record['deleted'] === true) {
    if (typeof record['id'] !== 'string' || !record['id']) {
      issues.push({ field: 'id', message: 'tombstone is missing an id' });
    }
    return issues;
  }

  for (const field of ['id', 'hostname', 'username', 'password'] as const) {
    if (typeof record[field] !== 'string') {
      issues.push({ field, message: `${field} must be a string` });
    }
  }

  const hasFormUrl =
    record['formSubmitURL'] !== undefined && record['formSubmitURL'] !== null;
  const hasRealm = record['httpRealm'] !== undefined && record['httpRealm'] !== null;
  if (hasFormUrl === hasRealm) {
    issues.push({
      field: 'formSubmitURL/httpRealm',
      message: hasFormUrl
        ? 'exactly one of formSubmitURL and httpRealm may be set, not both'
        : 'exactly one of formSubmitURL and httpRealm must be set',
    });
  }

  if (typeof record['hostname'] === 'string' && record['hostname'].length > 0) {
    try {
      // Firefox stores an origin, not a full URL — no path, no query.
      const url = new URL(record['hostname']);
      if (url.pathname !== '/' || url.search || url.hash) {
        issues.push({ field: 'hostname', message: 'hostname must be a bare origin' });
      }
    } catch {
      issues.push({ field: 'hostname', message: 'hostname is not a valid origin' });
    }
  }

  return issues;
}

export function isValidPasswordRecord(value: unknown): value is PasswordRecord {
  return validatePasswordRecord(value).length === 0;
}

export interface NewPasswordInput {
  origin: string;
  username: string;
  password: string;
  formActionOrigin?: string | null;
  httpRealm?: string | null;
  usernameField?: string;
  passwordField?: string;
  now?: number;
}

/** Create a record in exactly the shape Firefox expects. */
export function newPasswordRecord(input: NewPasswordInput): PasswordRecord {
  const now = input.now ?? Date.now();
  const isHttpAuth = input.httpRealm !== undefined && input.httpRealm !== null;
  return {
    id: newRecordId(),
    hostname: normalizeOrigin(input.origin),
    formSubmitURL: isHttpAuth ? null : normalizeOrigin(input.formActionOrigin ?? input.origin),
    httpRealm: isHttpAuth ? input.httpRealm ?? null : null,
    username: input.username,
    password: input.password,
    usernameField: input.usernameField ?? '',
    passwordField: input.passwordField ?? '',
    timeCreated: now,
    timePasswordChanged: now,
    timeLastUsed: now,
    timesUsed: 1,
  };
}

/** A tombstone, which is all Sync needs to propagate a deletion. */
export function passwordTombstone(id: string): PasswordRecord {
  return { id, deleted: true } as PasswordRecord;
}

/**
 * The timestamp that decides conflicts. `timePasswordChanged` is what Firefox
 * uses; fall back down the chain for records written by older clients.
 */
export function passwordAuthorityTime(record: PasswordRecord): number {
  return (
    record.timePasswordChanged ??
    record.timeCreated ??
    record.timeLastUsed ??
    0
  );
}

/** Bump usage counters the way Firefox does after a successful fill. */
export function markPasswordUsed(record: PasswordRecord, now = Date.now()): PasswordRecord {
  return { ...record, timeLastUsed: now, timesUsed: (record.timesUsed ?? 0) + 1 };
}

/** Apply a new password value, moving the conflict authority forward. */
export function changePassword(
  record: PasswordRecord,
  password: string,
  now = Date.now(),
): PasswordRecord {
  return { ...record, password, timePasswordChanged: now, timeLastUsed: now };
}

/** `https://Example.COM:443/login?x=1` becomes `https://example.com`. */
export function normalizeOrigin(input: string): string {
  try {
    const url = new URL(input);
    return url.origin;
  } catch {
    return input;
  }
}
