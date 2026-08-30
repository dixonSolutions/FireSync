/**
 * An in-memory stand-in for the Firefox Accounts auth server, the Mozilla
 * token server, and a Sync 1.5 storage node.
 *
 * It speaks enough of the real protocol — Hawk-authenticated requests,
 * `X-Last-Modified`, `X-If-Unmodified-Since` with 412 responses, batched
 * POSTs, `X-Weave-Next-Offset` pagination, `X-Weave-Backoff` — to drive the
 * whole `SyncEngine` end to end without a network.
 */

import { randomBytes, toB64 } from '../../src/common/bytes.ts';
import { CollectionKeys, encryptRecord } from '../../src/sync15/crypto.ts';
import type { KeyBundle } from '../../src/sync15/crypto.ts';
import type { BasicStorageObject } from '../../src/sync15/storage.ts';

export const AUTH_SERVER = 'https://api.accounts.firefox.com/v1';
export const TOKEN_SERVER = 'https://token.services.mozilla.com/1.0/sync/1.5';
export const STORAGE_NODE = 'https://sync-test.services.mozilla.com/1.5/42';

export interface FakeServerOptions {
  syncKeyBundle: KeyBundle;
  /** Seconds. Advances on every write so timestamps are monotonic. */
  clock?: number;
}

interface StoredBso extends BasicStorageObject {
  modified: number;
}

/** Anything with an id can be seeded: a real record, or a bare tombstone. */
export interface SeededRecord {
  id: string;
  deleted?: boolean;
}

export class FakeSyncServer {
  readonly collections = new Map<string, Map<string, StoredBso>>();
  readonly collectionKeys = CollectionKeys.generate();
  readonly requests: { method: string; url: string }[] = [];

  /** Set to a positive number of seconds to make the next reply ask for backoff. */
  backoffSeconds = 0;
  /** Force the next storage write to answer 412. */
  failNextWriteWith412 = false;
  /** Force the token server to answer 401 once. */
  tokenServerUnauthorizedOnce = false;

  private clock: number;
  private readonly syncKeyBundle: KeyBundle;
  private metaGlobal = {
    storageVersion: 5,
    syncID: 'meta-sync-id',
    engines: {
      passwords: { version: 1, syncID: 'passwords-sync-id' },
      addresses: { version: 1, syncID: 'addresses-sync-id' },
    },
    declined: [] as string[],
  };

  constructor(options: FakeServerOptions) {
    this.syncKeyBundle = options.syncKeyBundle;
    this.clock = options.clock ?? 1_700_000_000;
  }

  now(): number {
    return Math.round(this.clock * 100) / 100;
  }

  tick(seconds = 1): number {
    this.clock += seconds;
    return this.now();
  }

  setMetaGlobal(patch: Partial<typeof this.metaGlobal>): void {
    this.metaGlobal = { ...this.metaGlobal, ...patch };
  }

  /** Seed a decrypted record into a collection. */
  async seed(collection: string, record: SeededRecord): Promise<void> {
    const bundle = this.collectionKeys.forCollection(collection);
    const payload = await encryptRecord(bundle, record);
    this.put(collection, { id: record.id, payload: JSON.stringify(payload) });
  }

  private bucket(collection: string): Map<string, StoredBso> {
    let bucket = this.collections.get(collection);
    if (!bucket) {
      bucket = new Map();
      this.collections.set(collection, bucket);
    }
    return bucket;
  }

  private put(collection: string, bso: BasicStorageObject): number {
    const modified = this.tick(0.01);
    this.bucket(collection).set(bso.id, { ...bso, modified });
    return modified;
  }

  private lastModified(collection: string): number {
    const bucket = this.collections.get(collection);
    if (!bucket || bucket.size === 0) return 0;
    return Math.max(...[...bucket.values()].map((bso) => bso.modified));
  }

  /** Everything currently stored in a collection, decrypted. */
  async decrypted<T>(collection: string): Promise<T[]> {
    const bundle = this.collectionKeys.forCollection(collection);
    const { decryptRecord } = await import('../../src/sync15/crypto.ts');
    const out: T[] = [];
    for (const bso of this.bucket(collection).values()) {
      out.push(await decryptRecord<T>(bundle, JSON.parse(bso.payload)));
    }
    return out;
  }

  /** A `fetch`-compatible handler covering all three services. */
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push({ method, url: input });
    const url = new URL(input);

    if (input.startsWith(AUTH_SERVER)) return this.handleAuth(url, method, init);
    if (input.startsWith(TOKEN_SERVER)) return this.handleTokenServer();
    if (input.startsWith(STORAGE_NODE)) return this.handleStorage(url, method, init);

    return this.json({ error: 'unexpected host' }, 404);
  };

  // ------------------------------------------------------------- auth server

  private async handleAuth(url: URL, method: string, init?: RequestInit): Promise<Response> {
    if (url.pathname.endsWith('/oauth/token') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { grant_type?: string };
      return this.json({
        access_token: `access-${body.grant_type}`,
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: 'https://identity.mozilla.com/apps/oldsync',
      });
    }
    return this.json({ errno: 999, message: `unhandled auth path ${url.pathname}` }, 404);
  }

  // ------------------------------------------------------------ token server

  private handleTokenServer(): Response {
    if (this.tokenServerUnauthorizedOnce) {
      this.tokenServerUnauthorizedOnce = false;
      return this.json({ status: 'invalid-credentials' }, 401);
    }
    return this.json({
      id: 'hawk-id',
      key: 'hawk-key-value',
      uid: 42,
      api_endpoint: STORAGE_NODE,
      duration: 3600,
      hashalg: 'sha256',
    });
  }

  // ---------------------------------------------------------------- storage

  private async handleStorage(url: URL, method: string, init?: RequestInit): Promise<Response> {
    if (!init?.headers || !('authorization' in (init.headers as Record<string, string>))) {
      return this.json({ error: 'missing Hawk authorization' }, 401);
    }
    const authorization = (init.headers as Record<string, string>)['authorization'] ?? '';
    if (!authorization.startsWith('Hawk id="hawk-id"')) {
      return this.json({ error: 'bad Hawk header' }, 401);
    }

    const path = url.pathname.slice(new URL(STORAGE_NODE).pathname.length);

    if (path === '/info/collections') {
      const info: Record<string, number> = {};
      for (const name of this.collections.keys()) info[name] = this.lastModified(name);
      return this.json(info);
    }
    if (path === '/info/configuration') {
      return this.json({ max_post_records: 2, max_post_bytes: 100_000 });
    }
    if (path === '/info/quota') return this.json([1, 1000]);

    if (path === '/storage/meta/global' && method === 'GET') {
      return this.json({
        id: 'global',
        modified: this.now(),
        payload: JSON.stringify(this.metaGlobal),
      });
    }

    if (path === '/storage/crypto/keys' && method === 'GET') {
      const payload = await encryptRecord(this.syncKeyBundle, this.collectionKeys.toRecord());
      return this.json({ id: 'keys', modified: this.now(), payload: JSON.stringify(payload) });
    }

    const collectionMatch = /^\/storage\/([^/]+)$/.exec(path);
    if (collectionMatch) {
      const collection = collectionMatch[1] as string;
      if (method === 'GET') return this.readCollection(collection, url);
      if (method === 'POST') return this.writeCollection(collection, url, init);
    }

    const recordMatch = /^\/storage\/([^/]+)\/([^/]+)$/.exec(path);
    if (recordMatch && method === 'GET') {
      const [, collection, id] = recordMatch as unknown as [string, string, string];
      const bso = this.bucket(collection).get(id);
      if (!bso) return this.json({ error: 'not found' }, 404);
      return this.json(bso);
    }

    return this.json({ error: `unhandled storage path ${path}` }, 404);
  }

  private readCollection(collection: string, url: URL): Response {
    const newer = url.searchParams.get('newer');
    const limit = Number(url.searchParams.get('limit') ?? '200');
    const offset = Number(url.searchParams.get('offset') ?? '0');

    let records = [...this.bucket(collection).values()].sort((a, b) => a.modified - b.modified);
    if (newer !== null) records = records.filter((bso) => bso.modified > Number(newer));

    const page = records.slice(offset, offset + limit);
    const nextOffset = offset + limit < records.length ? String(offset + limit) : null;

    const headers: Record<string, string> = {
      'x-last-modified': String(this.lastModified(collection)),
      'x-weave-timestamp': String(this.now()),
    };
    if (nextOffset) headers['x-weave-next-offset'] = nextOffset;
    if (this.backoffSeconds > 0) headers['x-weave-backoff'] = String(this.backoffSeconds);

    return this.json(page, 200, headers);
  }

  private writeCollection(collection: string, url: URL, init?: RequestInit): Response {
    const unmodifiedSince = (init?.headers as Record<string, string> | undefined)?.[
      'x-if-unmodified-since'
    ];
    if (
      this.failNextWriteWith412 ||
      (unmodifiedSince !== undefined && this.lastModified(collection) > Number(unmodifiedSince))
    ) {
      this.failNextWriteWith412 = false;
      return this.json({}, 412, { 'x-last-modified': String(this.lastModified(collection)) });
    }

    const bsos = JSON.parse(String(init?.body ?? '[]')) as BasicStorageObject[];
    const success: string[] = [];
    for (const bso of bsos) {
      this.put(collection, bso);
      success.push(bso.id);
    }

    const body: Record<string, unknown> = {
      success,
      failed: {},
      modified: this.lastModified(collection),
    };
    if (url.searchParams.get('batch') === 'true' && url.searchParams.get('commit') !== 'true') {
      body['batch'] = 'batch-1';
    }
    return this.json(body, 200, { 'x-last-modified': String(this.lastModified(collection)) });
  }

  // ------------------------------------------------------------------ helper

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-weave-timestamp': String(this.now()),
        ...headers,
      },
    });
  }
}

/** A random 32+32 key bundle, for tests that need one. */
export function randomKeyBundle(): KeyBundle {
  return { encKey: randomBytes(32), hmacKey: randomBytes(32) };
}

/** base64 of a fresh 64-byte kSync, as the vault stores it. */
export function kSyncFor(bundle: KeyBundle): string {
  const combined = new Uint8Array(64);
  combined.set(bundle.encKey, 0);
  combined.set(bundle.hmacKey, 32);
  return toB64(combined);
}
