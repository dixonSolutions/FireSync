#!/usr/bin/env node
/**
 * The FireSync bridge — an optional native messaging host.
 *
 * Chrome starts this process, speaks to it over stdin/stdout using its
 * length-prefixed JSON framing, and kills it when the port closes. It listens on
 * no socket, opens no outbound connection, and does nothing until asked.
 *
 * Run `node bridge/host.mjs --self-test` to check it works outside a browser.
 *
 * Requires Node 22.5+ for `node:sqlite`.
 */

import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { keychainAvailable, keychainDelete, keychainGet, keychainSet } from './lib/keychain.mjs';
import { loopbackAuthorize } from './lib/loopback.mjs';
import { listProfiles, normaliseLogin, readLoginsFile } from './lib/profiles.mjs';
import { decryptLoginField, PrimaryPasswordError, readKey4 } from './lib/nss.mjs';

const require = createRequire(import.meta.url);
const { version } = require(join(dirname(fileURLToPath(import.meta.url)), 'package.json'));

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- stdio framing

/** Chrome frames each message as a 32-bit little-endian length plus JSON. */
export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. Chrome may split a message across reads or deliver
 * several at once, so this buffers and yields whole messages only.
 */
export class MessageDecoder {
  #buffer = Buffer.alloc(0);

  /** Chrome's own cap; a larger frame means the stream is desynchronised. */
  static MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];

    for (;;) {
      if (this.#buffer.length < 4) break;
      const length = this.#buffer.readUInt32LE(0);
      if (length > MessageDecoder.MAX_MESSAGE_BYTES) {
        throw new Error(`bridge: refusing a ${length}-byte frame`);
      }
      if (this.#buffer.length < 4 + length) break;

      const body = this.#buffer.subarray(4, 4 + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + length);
      messages.push(JSON.parse(body));
    }

    return messages;
  }
}

// -------------------------------------------------------------------- handlers

export function capabilities() {
  const list = ['profile', 'oauth'];
  if (keychainAvailable()) list.push('keychain');
  return list;
}

/** Import and decrypt every login in a Firefox profile. */
export async function importProfile(profilePath, primaryPassword = '') {
  const key = await readKey4(join(profilePath, 'key4.db'), primaryPassword);
  const logins = [];
  let skipped = 0;

  for (const login of readLoginsFile(profilePath)) {
    try {
      const username = decryptLoginField(login.encryptedUsername, key);
      const password = decryptLoginField(login.encryptedPassword, key);
      logins.push(normaliseLogin(login, username, password));
    } catch {
      // One unreadable record must not abandon the other several hundred.
      skipped += 1;
    }
  }

  return { logins, skipped };
}

export async function handle(request) {
  switch (request.method) {
    case 'info':
      return {
        protocol: PROTOCOL_VERSION,
        version,
        platform: platform(),
        capabilities: capabilities(),
      };

    case 'profile.list':
      return listProfiles();

    case 'profile.import':
      if (typeof request.path !== 'string' || !request.path) {
        throw new Error('profile.import needs a profile path');
      }
      return importProfile(request.path, request.primaryPassword ?? '');

    case 'keychain.get':
      return { secret: keychainGet(requireAccount(request)) };

    case 'keychain.set':
      if (typeof request.secret !== 'string') throw new Error('keychain.set needs a secret');
      keychainSet(requireAccount(request), request.secret);
      return null;

    case 'keychain.delete':
      keychainDelete(requireAccount(request));
      return null;

    case 'oauth.loopback': {
      if (typeof request.authorizationUrl !== 'string') {
        throw new Error('oauth.loopback needs an authorizationUrl');
      }
      const url = new URL(request.authorizationUrl);
      if (url.protocol !== 'https:') {
        throw new Error('oauth.loopback refuses a non-https authorization URL');
      }
      return loopbackAuthorize({
        authorizationUrl: request.authorizationUrl,
        redirectPath: request.redirectPath ?? '/',
        timeoutMs: request.timeoutMs ?? 300_000,
      });
    }

    default:
      throw Object.assign(new Error(`unknown method: ${request.method}`), {
        code: 'unsupported',
      });
  }
}

function requireAccount(request) {
  if (typeof request.account !== 'string' || !request.account) {
    throw new Error('this call needs an account name');
  }
  return request.account;
}

/** Turn a thrown value into the wire error shape, preserving known codes. */
export function toErrorResponse(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof PrimaryPasswordError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
  return code ? { id, ok: false, error: message, code } : { id, ok: false, error: message };
}

// ----------------------------------------------------------------------- main

async function main() {
  if (process.argv.includes('--self-test')) {
    const info = await handle({ id: 0, method: 'info' });
    const profiles = await handle({ id: 1, method: 'profile.list' });
    console.log(JSON.stringify({ info, profiles }, null, 2));
    console.log(
      profiles.length
        ? `\nFound ${profiles.length} Firefox profile(s). The bridge looks healthy.`
        : '\nNo Firefox profiles found. The bridge works; there is just nothing to import.',
    );
    return;
  }

  const decoder = new MessageDecoder();

  process.stdin.on('data', (chunk) => {
    let requests;
    try {
      requests = decoder.push(chunk);
    } catch (error) {
      process.stdout.write(encodeMessage(toErrorResponse(0, error)));
      process.exit(1);
    }

    for (const request of requests) {
      Promise.resolve()
        .then(() => handle(request))
        .then((result) => process.stdout.write(encodeMessage({ id: request.id, ok: true, result })))
        .catch((error) => process.stdout.write(encodeMessage(toErrorResponse(request.id, error))));
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
