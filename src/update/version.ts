/**
 * Chrome extension version comparison.
 *
 * A version is one to four dot-separated integers in 0–65535. Chrome compares
 * them numerically, component by component, with missing components treated as
 * zero — so `1.2` and `1.2.0.0` are the same version. Anything outside that
 * grammar is rejected rather than coerced: silently treating a malformed
 * version as "newer" would push a bad update at every user.
 */

const MAX_COMPONENT = 65535;
const MAX_COMPONENTS = 4;

export class InvalidVersionError extends Error {
  constructor(value: string, reason: string) {
    super(`invalid extension version "${value}": ${reason}`);
    this.name = 'InvalidVersionError';
  }
}

/** Parse a version into its numeric components. Throws on anything invalid. */
export function parseVersion(value: string): number[] {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidVersionError(String(value), 'not a non-empty string');
  }
  const parts = value.split('.');
  if (parts.length > MAX_COMPONENTS) {
    throw new InvalidVersionError(value, `more than ${MAX_COMPONENTS} components`);
  }
  return parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new InvalidVersionError(value, `component "${part}" is not a plain integer`);
    }
    const number = Number(part);
    if (number > MAX_COMPONENT) {
      throw new InvalidVersionError(value, `component "${part}" exceeds ${MAX_COMPONENT}`);
    }
    return number;
  });
}

/** `-1` if a < b, `0` if equal, `1` if a > b. Missing components count as zero. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Whether `candidate` is a genuine upgrade over `current`.
 *
 * Returns false — never throws — when either version is malformed. A broken
 * update manifest must not be able to trigger an update prompt.
 */
export function isNewer(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) === 1;
  } catch {
    return false;
  }
}

/** Whether a string is a well-formed extension version. */
export function isValidVersion(value: string): boolean {
  try {
    parseVersion(value);
    return true;
  } catch {
    return false;
  }
}
