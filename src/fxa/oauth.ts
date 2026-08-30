/**
 * The scoped-key OAuth flow — FireSync's preferred way to sign in.
 *
 * The user authenticates on `accounts.firefox.com` itself. FireSync never sees
 * the password, never holds a sessionToken, and never derives kB: Mozilla
 * hands back the 64-byte oldsync key already wrapped to an ephemeral P-256
 * key that only this extension holds.
 *
 * See docs/PROTOCOL.md#flow-b-scoped-key-oauth for why this is preferred over
 * the password flow, and what blocks it today (redirect-URI registration).
 */

import { fromB64Url, randomBytes, toB64Url, utf8 } from '../common/bytes.ts';
import { generateEcdhKeyPair, exportJwk, sha256 } from '../common/crypto.ts';
import { decryptEcdhEsJwe } from './jwe.ts';
import { OLDSYNC_SCOPE, splitKSync } from './onepw.ts';
import type { SyncKeyMaterial } from './onepw.ts';

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 S256 PKCE pair. */
export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = toB64Url(randomBytes(32));
  const codeChallenge = toB64Url(await sha256(utf8(codeVerifier)));
  return { codeVerifier, codeChallenge };
}

export interface ScopedKeyRequest {
  /** Ephemeral private key; keep in `chrome.storage.session` until the code is redeemed. */
  privateKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  /** base64url(JSON(public JWK)) — the `keys_jwk` query parameter. */
  keysJwk: string;
}

/** Generate the ephemeral P-256 key pair and encode the `keys_jwk` parameter. */
export async function createScopedKeyRequest(): Promise<ScopedKeyRequest> {
  const pair = await generateEcdhKeyPair();
  const publicJwk = (await exportJwk(pair.publicKey)) as JsonWebKey & { x: string; y: string };
  // FxA expects a bare public JWK: kty/crv/x/y and nothing else.
  const minimal = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  return {
    privateKey: pair.privateKey,
    privateKeyJwk: await exportJwk(pair.privateKey),
    keysJwk: toB64Url(utf8(JSON.stringify(minimal))),
  };
}

export interface AuthorizationUrlOptions {
  contentServerUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  keysJwk: string;
  scope?: string;
  email?: string;
  accessType?: 'online' | 'offline';
  /** Force the account chooser rather than silently reusing a signed-in user. */
  prompt?: 'none' | 'consent' | 'login';
}

/** Build the `/authorization` URL the user is sent to. */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL('/authorization', options.contentServerUrl);
  const params: Record<string, string> = {
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: options.scope ?? `profile ${OLDSYNC_SCOPE}`,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    keys_jwk: options.keysJwk,
    access_type: options.accessType ?? 'offline',
  };
  if (options.email) params['email'] = options.email;
  if (options.prompt) params['prompt'] = options.prompt;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface RedirectResult {
  code: string;
  state: string;
}

/**
 * Pull `code`/`state` out of a redirect URL, checking `state` first.
 *
 * Returns null when the URL is not the redirect we are waiting for, so a
 * `tabs.onUpdated` listener can call this on every navigation cheaply.
 */
export function parseRedirect(
  url: string,
  expected: { redirectUri: string; state: string },
): RedirectResult | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const target = new URL(expected.redirectUri);
  if (parsed.origin !== target.origin || parsed.pathname !== target.pathname) return null;

  const error = parsed.searchParams.get('error');
  if (error) {
    throw new Error(
      `authorization failed: ${error}${
        parsed.searchParams.get('error_description')
          ? ` (${parsed.searchParams.get('error_description')})`
          : ''
      }`,
    );
  }

  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code || !state) return null;
  if (state !== expected.state) {
    throw new Error('authorization state mismatch — possible CSRF, aborting');
  }
  return { code, state };
}

/** Decrypt `keys_jwe` and pull out the oldsync scoped key. */
export async function unwrapScopedKeys(
  keysJwe: string,
  privateKey: CryptoKey,
  scope: string = OLDSYNC_SCOPE,
): Promise<{ kid: string; keys: SyncKeyMaterial }> {
  const plaintext = await decryptEcdhEsJwe(keysJwe, privateKey);
  const bundle = JSON.parse(plaintext) as Record<string, { kid: string; k: string; kty: string }>;
  const entry = bundle[scope];
  if (!entry) {
    throw new Error(
      `scoped key bundle has no entry for ${scope} (got: ${Object.keys(bundle).join(', ')})`,
    );
  }
  const raw = fromB64Url(entry.k);
  if (raw.length !== 64) {
    throw new Error(`oldsync scoped key must be 64 bytes, got ${raw.length}`);
  }
  return { kid: entry.kid, keys: splitKSync(raw) };
}

/** Random opaque `state` value for the authorization request. */
export function newState(): string {
  return toB64Url(randomBytes(16));
}

/** Re-exported so callers can decode a `kid` without importing bytes directly. */
export const decodeB64Url = fromB64Url;
