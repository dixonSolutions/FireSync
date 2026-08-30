/**
 * Hawk (v1) request signing.
 *
 * Used in two places by FireSync:
 *   1. Firefox Accounts endpoints authenticated by a sessionToken or
 *      keyFetchToken (`id` = hex(tokenId), `key` = reqHMACkey).
 *   2. Every Sync 1.5 storage request (`id`/`key` come from the token server).
 *
 * Spec: https://github.com/mozilla/hawk/blob/main/API.md
 *
 * Verified against the canonical Hawk README vectors in `test/hawk.test.ts`.
 */

import { randomBytes, toB64, toHex, utf8 } from './bytes.ts';
import { hmacSha256, sha256 } from './crypto.ts';

export interface HawkCredentials {
  id: string;
  /** Raw key bytes, or an ASCII key string as returned by the token server. */
  key: Uint8Array | string;
  algorithm?: 'sha256';
}

export interface HawkArtifacts {
  ts: number;
  nonce: string;
  method: string;
  resource: string;
  host: string;
  port: number;
  hash: string;
  ext: string;
}

export interface HawkOptions {
  method: string;
  url: string;
  credentials: HawkCredentials;
  /** Request body, if any. When present a payload hash is included. */
  payload?: string;
  contentType?: string;
  ext?: string;
  /** Unix seconds. Injectable so tests are deterministic. */
  ts?: number;
  nonce?: string;
  /** Seconds to add to the local clock, learned from `X-Weave-Timestamp`. */
  localtimeOffsetSec?: number;
}

function keyBytes(key: Uint8Array | string): Uint8Array {
  return typeof key === 'string' ? utf8(key) : key;
}

/** Hawk escapes backslash and newline inside the `ext` field. */
function escapeExt(ext: string): string {
  return ext.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function defaultPort(protocol: string): number {
  return protocol === 'http:' ? 80 : 443;
}

/**
 * `hawk.1.payload\n<content-type>\n<payload>\n` digested and base64'd.
 * The content type is lower-cased and stripped of parameters.
 */
export async function calculatePayloadHash(
  payload: string,
  contentType: string,
): Promise<string> {
  const normalizedType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const normalized = `hawk.1.payload\n${normalizedType}\n${payload}\n`;
  return toB64(await sha256(utf8(normalized)));
}

/** Build the Hawk normalized string for a request. */
export function normalizeString(artifacts: HawkArtifacts, type = 'header'): string {
  return (
    `hawk.1.${type}\n` +
    `${artifacts.ts}\n` +
    `${artifacts.nonce}\n` +
    `${artifacts.method.toUpperCase()}\n` +
    `${artifacts.resource}\n` +
    `${artifacts.host.toLowerCase()}\n` +
    `${artifacts.port}\n` +
    `${artifacts.hash}\n` +
    `${escapeExt(artifacts.ext)}\n`
  );
}

/** Compute the request MAC. */
export async function calculateMac(
  credentials: HawkCredentials,
  artifacts: HawkArtifacts,
  type = 'header',
): Promise<string> {
  const mac = await hmacSha256(keyBytes(credentials.key), utf8(normalizeString(artifacts, type)));
  return toB64(mac);
}

export interface HawkResult {
  header: string;
  artifacts: HawkArtifacts;
}

/** Produce the full `Authorization: Hawk ...` header value for a request. */
export async function hawkHeader(options: HawkOptions): Promise<HawkResult> {
  const url = new URL(options.url);
  const algorithm = options.credentials.algorithm ?? 'sha256';
  if (algorithm !== 'sha256') {
    throw new Error(`unsupported Hawk algorithm: ${algorithm}`);
  }

  const hash =
    options.payload !== undefined
      ? await calculatePayloadHash(options.payload, options.contentType ?? 'application/json')
      : '';

  const artifacts: HawkArtifacts = {
    ts:
      options.ts ??
      Math.floor(Date.now() / 1000) + Math.floor(options.localtimeOffsetSec ?? 0),
    nonce: options.nonce ?? toHex(randomBytes(4)),
    method: options.method,
    resource: url.pathname + url.search,
    host: url.hostname,
    port: url.port ? Number(url.port) : defaultPort(url.protocol),
    hash,
    ext: options.ext ?? '',
  };

  const mac = await calculateMac(options.credentials, artifacts);

  let header =
    `Hawk id="${options.credentials.id}", ts="${artifacts.ts}", nonce="${artifacts.nonce}"`;
  if (artifacts.hash) header += `, hash="${artifacts.hash}"`;
  if (artifacts.ext) header += `, ext="${escapeExt(artifacts.ext)}"`;
  header += `, mac="${mac}"`;

  return { header, artifacts };
}
