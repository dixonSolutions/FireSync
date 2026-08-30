/**
 * The FireSync bridge protocol.
 *
 * The bridge is an **optional** native messaging host: a small local process the
 * extension talks to over stdio. Chrome frames the messages; there is no socket,
 * no port, and nothing listening on the network except transiently during a
 * loopback OAuth redirect the user explicitly started.
 *
 * It exists because three useful things are impossible from inside an extension
 * sandbox, and for no other reason. It is never required: FireSync works
 * completely without it, and every call degrades to "bridge unavailable".
 *
 *   1. `profile.*` — read the local Firefox profile (`logins.json` + `key4.db`)
 *      and decrypt it. This is the important one: it imports a user's logins
 *      with no Mozilla account, no network, and no borrowed OAuth client id, so
 *      it is the one path not exposed to the project's largest external risk.
 *   2. `keychain.*` — hold the vault key in the OS keychain (libsecret, macOS
 *      Keychain, Windows DPAPI) so the vault can unlock without a passphrase on
 *      a machine the user has already unlocked.
 *   3. `oauth.loopback` — RFC 8252 native-app OAuth against `127.0.0.1`. Shipped,
 *      but only useful once FireSync has its own registered OAuth client; see
 *      docs/PROTOCOL.md#oauth-client-identity.
 *
 * Full rationale: docs/BRIDGE.md.
 */

export const BRIDGE_HOST_NAME = 'com.firesync.bridge';

/** Bumped when the wire format changes incompatibly. */
export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeCapability = 'profile' | 'keychain' | 'oauth';

export interface BridgeInfo {
  protocol: number;
  version: string;
  platform: string;
  capabilities: BridgeCapability[];
}

export interface FirefoxProfile {
  name: string;
  path: string;
  /** Whether `logins.json` and `key4.db` are both present. */
  hasLogins: boolean;
  /** Whether the profile is protected by a primary password. */
  requiresPrimaryPassword: boolean;
  loginCount: number;
}

export interface ImportedLogin {
  origin: string;
  formActionOrigin: string | null;
  httpRealm: string | null;
  username: string;
  password: string;
  usernameField: string;
  passwordField: string;
  timeCreated: number;
  timePasswordChanged: number;
  timeLastUsed: number;
  timesUsed: number;
}

export type BridgeRequest =
  | { id: number; method: 'info' }
  | { id: number; method: 'profile.list' }
  | { id: number; method: 'profile.import'; path: string; primaryPassword?: string }
  | { id: number; method: 'keychain.get'; account: string }
  | { id: number; method: 'keychain.set'; account: string; secret: string }
  | { id: number; method: 'keychain.delete'; account: string }
  | {
      id: number;
      method: 'oauth.loopback';
      authorizationUrl: string;
      redirectPath?: string;
      timeoutMs?: number;
    };

export type BridgeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: BridgeErrorCode };

export type BridgeErrorCode =
  | 'unsupported'
  | 'not-found'
  | 'primary-password-required'
  | 'primary-password-wrong'
  | 'legacy-profile'
  | 'timeout'
  | 'cancelled';

export interface BridgeResultMap {
  info: BridgeInfo;
  'profile.list': FirefoxProfile[];
  'profile.import': { logins: ImportedLogin[]; skipped: number };
  'keychain.get': { secret: string | null };
  'keychain.set': null;
  'keychain.delete': null;
  'oauth.loopback': { code: string; state: string };
}

/** Thrown when the host is absent, which is the normal case. */
export class BridgeUnavailableError extends Error {
  constructor(message = 'the FireSync bridge is not installed') {
    super(message);
    this.name = 'BridgeUnavailableError';
  }
}

export class BridgeError extends Error {
  constructor(message: string, readonly code?: BridgeErrorCode) {
    super(message);
    this.name = 'BridgeError';
  }
}
