/**
 * Bridge tests: the stdio framing, the DER reader, the NSS decryptor against a
 * synthetic Firefox profile, and the extension-side client against a fake port.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeMessage, handle, importProfile, MessageDecoder, toErrorResponse } from '../bridge/host.mjs';
import { at, decodeInteger, decodeOid, parse, readTlv, unpad } from '../bridge/lib/der.mjs';
import { decryptLoginField, PrimaryPasswordError, readKey4 } from '../bridge/lib/nss.mjs';
import { normaliseLogin } from '../bridge/lib/profiles.mjs';
import { encryptLoginField, makeProfile } from './helpers/firefox-profile.mjs';
import { integer, octet, oid, seq } from './helpers/der-encode.mjs';
import { BridgeClient } from '../src/bridge/client.ts';
import { BridgeError, BridgeUnavailableError } from '../src/bridge/protocol.ts';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profile(options?: Parameters<typeof makeProfile>[0]) {
  const built = makeProfile(options);
  cleanup.push(built.dir);
  return built;
}

// ---------------------------------------------------------------------- DER

describe('DER reader', () => {
  it('round-trips structures written by an independent encoder', () => {
    const buffer = seq(oid('1.2.840.113549.1.5.13'), seq(octet(Buffer.from('salt')), integer(600000)));
    const root = parse(buffer);

    expect(decodeOid(at(root, 0).value)).toBe('1.2.840.113549.1.5.13');
    expect(Buffer.from(at(root, 1, 0).value).toString()).toBe('salt');
    expect(decodeInteger(at(root, 1, 1).value)).toBe(600000);
  });

  it('handles multi-byte lengths', () => {
    const big = seq(octet(Buffer.alloc(500, 0xab)));
    expect(at(parse(big), 0).value).toHaveLength(500);
  });

  it('rejects a truncated buffer rather than reading past it', () => {
    expect(() => parse(Buffer.from([0x30, 0x10, 0x04]))).toThrow(/past the end|truncated/);
  });

  it('rejects an unsupported long-form length', () => {
    expect(() => readTlv(Buffer.from([0x04, 0x8a, 0, 0, 0, 0]))).toThrow(/unsupported length/);
  });

  it('reports a missing path clearly', () => {
    expect(() => at(parse(seq(octet(Buffer.from('x')))), 5)).toThrow(/no child at path/);
  });

  it('validates PKCS#7 padding instead of trusting the last byte', () => {
    expect(unpad(Buffer.from([1, 2, 6, 6, 6, 6, 6, 6]), 8)).toEqual(Buffer.from([1, 2]));
    expect(() => unpad(Buffer.from([1, 2, 3, 4, 5, 6, 7, 9]), 8)).toThrow(/invalid length/);
    expect(() => unpad(Buffer.from([1, 2, 3, 4, 5, 3, 9, 3]), 8)).toThrow(/inconsistent/);
    expect(() => unpad(Buffer.from([1, 2, 3]), 8)).toThrow(/whole number of blocks/);
  });
});

// ---------------------------------------------------------------------- NSS

describe('NSS profile decryption', () => {
  it('recovers the 3DES key from a modern key4.db', async () => {
    const built = profile();
    const key = await readKey4(join(built.dir, 'key4.db'), '');
    expect(Buffer.from(key)).toEqual(built.tripleDesKey);
  });

  it('recovers the key from a legacy 3DES-wrapped key4.db', async () => {
    const built = profile({ legacy: true });
    const key = await readKey4(join(built.dir, 'key4.db'), '');
    expect(Buffer.from(key)).toEqual(built.tripleDesKey);
  });

  it('decrypts a logins.json field', () => {
    const built = profile();
    const encrypted = encryptLoginField(built.tripleDesKey, 'hunter2');
    expect(decryptLoginField(encrypted, built.tripleDesKey)).toBe('hunter2');
  });

  it('reports that a primary password is required, distinctly from a wrong one', async () => {
    const built = profile({ password: 'the primary password' });
    const path = join(built.dir, 'key4.db');

    await expect(readKey4(path, '')).rejects.toMatchObject({
      name: 'PrimaryPasswordError',
      code: 'primary-password-required',
    });
    await expect(readKey4(path, 'wrong')).rejects.toMatchObject({
      code: 'primary-password-wrong',
    });
    await expect(readKey4(path, 'the primary password')).resolves.toBeDefined();
  });

  it('rejects a field encrypted under a different key', () => {
    const a = profile();
    const b = profile();
    const encrypted = encryptLoginField(a.tripleDesKey, 'hunter2');
    expect(() => decryptLoginField(encrypted, b.tripleDesKey)).toThrow();
  });
});

// ------------------------------------------------------------------- import

describe('profile import', () => {
  it('decrypts every login in a profile', async () => {
    const built = profile({
      logins: [
        { origin: 'https://example.com', username: 'ada', password: 'hunter2' },
        { origin: 'https://other.test', username: 'grace', password: 'compiler', httpRealm: 'Realm' },
      ],
    });

    const result = await importProfile(built.dir, '');

    expect(result.skipped).toBe(0);
    expect(result.logins).toHaveLength(2);
    expect(result.logins[0]).toMatchObject({
      origin: 'https://example.com',
      username: 'ada',
      password: 'hunter2',
      formActionOrigin: 'https://example.com',
      httpRealm: null,
      usernameField: 'email',
      timesUsed: 3,
    });
    expect(result.logins[1]).toMatchObject({
      httpRealm: 'Realm',
      formActionOrigin: null,
      username: 'grace',
    });
  });

  it('skips an unreadable record rather than abandoning the rest', async () => {
    const built = profile({
      logins: [
        { origin: 'https://a.test', username: 'ada', password: 'p', corrupt: 'username' },
        { origin: 'https://b.test', username: 'grace', password: 'q' },
      ],
    });

    const result = await importProfile(built.dir, '');
    expect(result.skipped).toBe(1);
    expect(result.logins).toHaveLength(1);
    expect(result.logins[0]?.username).toBe('grace');
  });

  it('produces records that map cleanly onto FireSync password records', () => {
    const normalised = normaliseLogin(
      {
        hostname: 'https://example.com',
        formSubmitURL: 'https://auth.example.com',
        httpRealm: null,
        usernameField: 'email',
        passwordField: 'pass',
        timeCreated: 1,
        timePasswordChanged: 2,
        timeLastUsed: 3,
        timesUsed: 4,
      },
      'ada',
      'hunter2',
    );
    expect(normalised).toEqual({
      origin: 'https://example.com',
      formActionOrigin: 'https://auth.example.com',
      httpRealm: null,
      username: 'ada',
      password: 'hunter2',
      usernameField: 'email',
      passwordField: 'pass',
      timeCreated: 1,
      timePasswordChanged: 2,
      timeLastUsed: 3,
      timesUsed: 4,
    });
  });
});

// ------------------------------------------------------------------- framing

describe('native messaging framing', () => {
  it('encodes a 32-bit little-endian length prefix', () => {
    const framed = encodeMessage({ a: 1 });
    expect(framed.readUInt32LE(0)).toBe(framed.length - 4);
    expect(JSON.parse(framed.subarray(4).toString())).toEqual({ a: 1 });
  });

  it('reassembles a message split across chunks', () => {
    const decoder = new MessageDecoder();
    const framed = encodeMessage({ id: 7, method: 'info' });

    expect(decoder.push(framed.subarray(0, 3))).toEqual([]);
    expect(decoder.push(framed.subarray(3, 6))).toEqual([]);
    expect(decoder.push(framed.subarray(6))).toEqual([{ id: 7, method: 'info' }]);
  });

  it('yields several messages delivered in one chunk', () => {
    const decoder = new MessageDecoder();
    const chunk = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })]);
    expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('refuses an absurd frame length rather than allocating', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff, 0);
    expect(() => new MessageDecoder().push(header)).toThrow(/refusing a/);
  });
});

// ------------------------------------------------------------------ handlers

describe('host handlers', () => {
  it('answers info with its protocol version and capabilities', async () => {
    const info = await handle({ id: 1, method: 'info' });
    expect(info.protocol).toBe(1);
    expect(info.capabilities).toContain('profile');
  });

  it('rejects an unknown method with the unsupported code', async () => {
    await expect(handle({ id: 1, method: 'nope' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('refuses a non-https authorization URL', async () => {
    await expect(
      handle({ id: 1, method: 'oauth.loopback', authorizationUrl: 'http://evil.test/' }),
    ).rejects.toThrow(/non-https/);
  });

  it('requires an account name for keychain calls', async () => {
    await expect(handle({ id: 1, method: 'keychain.get' })).rejects.toThrow(/account name/);
  });

  it('preserves a primary-password code in the error response', () => {
    const response = toErrorResponse(
      3,
      new PrimaryPasswordError('nope', 'primary-password-required'),
    );
    expect(response).toEqual({
      id: 3,
      ok: false,
      error: 'nope',
      code: 'primary-password-required',
    });
  });
});

// -------------------------------------------------------------------- client

/** A fake `chrome.runtime.Port` driven by a handler function. */
function fakePort(handler: (request: any) => unknown | Promise<unknown>) {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];

  return {
    port: {
      name: 'fake',
      onMessage: { addListener: (fn: (m: unknown) => void) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
      postMessage: (request: any) => {
        Promise.resolve()
          .then(() => handler(request))
          .then((result) =>
            messageListeners.forEach((fn) => fn({ id: request.id, ok: true, result })),
          )
          .catch((error: Error) =>
            messageListeners.forEach((fn) =>
              fn({ id: request.id, ok: false, error: error.message }),
            ),
          );
      },
      disconnect: () => disconnectListeners.forEach((fn) => fn()),
    } as unknown as chrome.runtime.Port,
    drop: () => disconnectListeners.forEach((fn) => fn()),
  };
}

describe('BridgeClient', () => {
  it('round-trips a call through the port', async () => {
    const { port } = fakePort((request) =>
      request.method === 'info'
        ? { protocol: 1, version: '0.1.0', platform: 'linux', capabilities: ['profile'] }
        : null,
    );
    const client = new BridgeClient({ connect: () => port, lastError: () => undefined });

    await expect(client.info()).resolves.toMatchObject({ protocol: 1 });
    expect(await client.isAvailable()).toBe(true);
  });

  it('rejects a host speaking a different protocol version', async () => {
    const { port } = fakePort(() => ({ protocol: 99, version: 'x', platform: 'linux', capabilities: [] }));
    const client = new BridgeClient({ connect: () => port, lastError: () => undefined });

    await expect(client.info()).rejects.toThrow(/protocol 99/);
    expect(await client.isAvailable()).toBe(false);
  });

  it('surfaces a missing host as BridgeUnavailableError, not a crash', async () => {
    const client = new BridgeClient({
      connect: () => {
        throw new Error('Specified native messaging host not found.');
      },
    });
    await expect(client.info()).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(await client.isAvailable()).toBe(false);
  });

  it('classifies a disconnect that names a missing host', async () => {
    const fake = fakePort(() => new Promise(() => {}));
    const client = new BridgeClient({
      connect: () => fake.port,
      lastError: () => 'Specified native messaging host not found.',
    });

    const pending = client.listProfiles();
    fake.drop();
    await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it('classifies any other disconnect as a bridge error', async () => {
    const fake = fakePort(() => new Promise(() => {}));
    const client = new BridgeClient({
      connect: () => fake.port,
      lastError: () => 'Native host has exited.',
    });

    const pending = client.listProfiles();
    fake.drop();
    await expect(pending).rejects.toBeInstanceOf(BridgeError);
  });

  it('times out a call that never answers', async () => {
    vi.useFakeTimers();
    const { port } = fakePort(() => new Promise(() => {}));
    const client = new BridgeClient({ connect: () => port, timeoutMs: 50, lastError: () => undefined });

    const pending = client.listProfiles();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('propagates a host error with its code', async () => {
    const { port } = fakePort(() => {
      throw new Error('this Firefox profile is protected by a primary password');
    });
    const client = new BridgeClient({ connect: () => port, lastError: () => undefined });

    await expect(client.importProfile('/tmp/profile')).rejects.toThrow(/primary password/);
  });

  it('sends the primary password only when one was supplied', async () => {
    const seen: any[] = [];
    const { port } = fakePort((request) => {
      seen.push(request);
      return { logins: [], skipped: 0 };
    });
    const client = new BridgeClient({ connect: () => port, lastError: () => undefined });

    await client.importProfile('/tmp/a');
    await client.importProfile('/tmp/b', 'secret');

    expect(seen[0]).not.toHaveProperty('primaryPassword');
    expect(seen[1]).toHaveProperty('primaryPassword', 'secret');
  });
});
