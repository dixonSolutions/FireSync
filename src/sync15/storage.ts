/**
 * Sync 1.5 storage client.
 *
 * Everything the server exposes that FireSync needs: collection listings,
 * paginated record fetches, single-record writes, batched uploads, tombstones,
 * and the three pieces of protocol etiquette that a well-behaved client owes
 * Mozilla's infrastructure:
 *
 *   1. Honour `X-Weave-Backoff` / `Retry-After` unconditionally.
 *   2. Send `X-If-Unmodified-Since` on every write and handle 412 by
 *      re-reading rather than clobbering.
 *   3. Track `X-Weave-Timestamp` so Hawk signatures survive clock skew.
 *
 * Reference: https://mozilla-services.readthedocs.io/en/latest/storage/apis-1.5.html
 */

import { hawkHeader } from '../common/hawk.ts';
import type { HawkCredentials } from '../common/hawk.ts';
import type { FetchLike } from '../fxa/client.ts';
import type { EncryptedPayload } from './crypto.ts';

/** A Basic Storage Object as it appears on the wire. */
export interface BasicStorageObject {
  id: string;
  /** Server-assigned modification time, in seconds with 2 decimal places. */
  modified?: number;
  /** JSON string. For encrypted collections this is an `EncryptedPayload`. */
  payload: string;
  sortindex?: number;
  ttl?: number;
}

export interface StorageError extends Error {
  status: number;
}

export class SyncStorageError extends Error implements StorageError {
  constructor(message: string, readonly status: number, readonly responseBody = '') {
    super(message);
    this.name = 'SyncStorageError';
  }
}

/** HTTP 412: someone else wrote to this collection since we last read it. */
export class ConflictError extends SyncStorageError {
  constructor(readonly serverLastModified: number | null) {
    super('collection changed on the server since our last read (412)', 412);
    this.name = 'ConflictError';
  }
}

/** HTTP 401: the Hawk credentials from the token server are no longer valid. */
export class StorageAuthError extends SyncStorageError {
  constructor() {
    super('sync storage rejected our Hawk credentials (401)', 401);
    this.name = 'StorageAuthError';
  }
}

export interface GetCollectionOptions {
  /** Return whole BSOs rather than just ids. */
  full?: boolean;
  /** Only records modified strictly after this timestamp (seconds). */
  newer?: number;
  older?: number;
  ids?: string[];
  limit?: number;
  sort?: 'newest' | 'oldest' | 'index';
  offset?: string;
}

export interface CollectionPage {
  records: BasicStorageObject[];
  /** `X-Last-Modified` for the collection at the time of this read. */
  lastModified: number | null;
  /** `X-Weave-Next-Offset`, when the result was truncated. */
  nextOffset: string | null;
}

export interface ServerConfiguration {
  max_post_records?: number;
  max_post_bytes?: number;
  max_total_records?: number;
  max_total_bytes?: number;
  max_request_bytes?: number;
  max_record_payload_bytes?: number;
}

export interface PostResponse {
  success: string[];
  failed: Record<string, string>;
  /** Present when a batch is open. */
  batch?: string;
  modified?: number;
}

export interface SyncStorageClientOptions {
  /** `api_endpoint` from the token server, e.g. `https://…/1.5/12345`. */
  endpoint: string;
  credentials: HawkCredentials;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

export class SyncStorageClient {
  private readonly endpoint: string;
  private readonly credentials: HawkCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string | undefined;

  /** Epoch ms before which we must not talk to the server again. */
  private backoffUntil = 0;
  /** Seconds to add to the local clock when signing. */
  private clockOffsetSec = 0;
  /** Last `X-Last-Modified` seen, per collection. */
  private readonly lastModified = new Map<string, number>();

  constructor(options: SyncStorageClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent;
  }

  /** Epoch ms until which the server asked us to stay away. 0 when clear. */
  get backoffUntilMs(): number {
    return this.backoffUntil;
  }

  get clockOffsetSeconds(): number {
    return this.clockOffsetSec;
  }

  /** Last known server modification time for a collection, if we have read it. */
  lastModifiedFor(collection: string): number | undefined {
    return this.lastModified.get(collection);
  }

  // ---------------------------------------------------------------- transport

  private buildUrl(path: string, query: Record<string, string | undefined> = {}): string {
    const url = new URL(`${this.endpoint}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private noteResponseMetadata(response: Response, collection?: string): void {
    const serverTimestamp = response.headers.get('x-weave-timestamp');
    if (serverTimestamp) {
      const serverSec = Number(serverTimestamp);
      if (!Number.isNaN(serverSec)) {
        this.clockOffsetSec = serverSec - Date.now() / 1000;
      }
    }

    const backoff =
      response.headers.get('x-weave-backoff') ??
      response.headers.get('x-backoff') ??
      (response.status === 503 || response.status === 429
        ? response.headers.get('retry-after')
        : null);
    if (backoff) {
      const seconds = Number(backoff);
      if (!Number.isNaN(seconds) && seconds > 0) {
        this.backoffUntil = Math.max(this.backoffUntil, Date.now() + seconds * 1000);
      }
    }

    if (collection) {
      const modified = response.headers.get('x-last-modified');
      if (modified) {
        const value = Number(modified);
        if (!Number.isNaN(value)) this.lastModified.set(collection, value);
      }
    }
  }

  private async request(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      unmodifiedSince?: number;
      collection?: string;
      ignoreBackoff?: boolean;
    } = {},
  ): Promise<{ response: Response; text: string }> {
    if (!options.ignoreBackoff && Date.now() < this.backoffUntil) {
      throw new SyncStorageError(
        `server backoff in effect for another ${Math.ceil(
          (this.backoffUntil - Date.now()) / 1000,
        )}s`,
        503,
      );
    }

    const url = this.buildUrl(path, options.query ?? {});
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (this.userAgent) headers['user-agent'] = this.userAgent;
    if (options.unmodifiedSince !== undefined) {
      headers['x-if-unmodified-since'] = String(options.unmodifiedSince);
    }

    const { header } = await hawkHeader({
      method,
      url,
      credentials: this.credentials,
      ...(payload !== undefined ? { payload, contentType: 'application/json' } : {}),
      localtimeOffsetSec: this.clockOffsetSec,
    });
    headers['authorization'] = header;

    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    });

    this.noteResponseMetadata(response, options.collection);
    const text = await response.text();

    if (response.status === 401) throw new StorageAuthError();
    if (response.status === 412) {
      const header412 = response.headers.get('x-last-modified');
      throw new ConflictError(header412 ? Number(header412) : null);
    }
    if (!response.ok) {
      throw new SyncStorageError(
        `sync storage ${method} ${path} failed with ${response.status}`,
        response.status,
        text.slice(0, 500),
      );
    }

    return { response, text };
  }

  private async requestJson<T>(
    method: string,
    path: string,
    options: Parameters<SyncStorageClient['request']>[2] = {},
  ): Promise<T> {
    const { text } = await this.request(method, path, options);
    return (text ? JSON.parse(text) : null) as T;
  }

  // -------------------------------------------------------------------- reads

  /** `GET /info/collections` — collection name to last-modified timestamp. */
  async infoCollections(): Promise<Record<string, number>> {
    return this.requestJson<Record<string, number>>('GET', '/info/collections');
  }

  /** `GET /info/collection_counts`. */
  async infoCollectionCounts(): Promise<Record<string, number>> {
    return this.requestJson<Record<string, number>>('GET', '/info/collection_counts');
  }

  /** `GET /info/configuration` — batch limits this node enforces. */
  async infoConfiguration(): Promise<ServerConfiguration> {
    return this.requestJson<ServerConfiguration>('GET', '/info/configuration');
  }

  /** `GET /info/quota` — `[usedKB, quotaKB]`. */
  async infoQuota(): Promise<[number, number | null]> {
    return this.requestJson<[number, number | null]>('GET', '/info/quota');
  }

  /** One page of a collection. */
  async getCollection(
    collection: string,
    options: GetCollectionOptions = {},
  ): Promise<CollectionPage> {
    const query: Record<string, string | undefined> = {
      full: options.full ? '1' : undefined,
      newer: options.newer !== undefined ? String(options.newer) : undefined,
      older: options.older !== undefined ? String(options.older) : undefined,
      ids: options.ids?.length ? options.ids.join(',') : undefined,
      limit: options.limit !== undefined ? String(options.limit) : undefined,
      sort: options.sort,
      offset: options.offset,
    };
    const { response, text } = await this.request('GET', `/storage/${collection}`, {
      query,
      collection,
    });
    const parsed = (text ? JSON.parse(text) : []) as unknown[];
    const records: BasicStorageObject[] = options.full
      ? (parsed as BasicStorageObject[])
      : (parsed as string[]).map((id) => ({ id, payload: '' }));

    const lastModifiedHeader = response.headers.get('x-last-modified');
    return {
      records,
      lastModified: lastModifiedHeader ? Number(lastModifiedHeader) : null,
      nextOffset: response.headers.get('x-weave-next-offset'),
    };
  }

  /**
   * Every record in a collection, following `X-Weave-Next-Offset`.
   *
   * `limit` bounds each page, not the total. The server's own `X-Last-Modified`
   * from the first page is returned so the caller can use it as the high-water
   * mark for the next incremental sync.
   */
  async getAllRecords(
    collection: string,
    options: GetCollectionOptions = {},
  ): Promise<{ records: BasicStorageObject[]; lastModified: number | null }> {
    const all: BasicStorageObject[] = [];
    let offset: string | undefined = options.offset;
    let lastModified: number | null = null;
    let pages = 0;

    do {
      const page: CollectionPage = await this.getCollection(collection, {
        ...options,
        full: options.full ?? true,
        limit: options.limit ?? 200,
        offset,
      });
      if (pages === 0) lastModified = page.lastModified;
      all.push(...page.records);
      offset = page.nextOffset ?? undefined;
      pages += 1;
      if (pages > 500) throw new SyncStorageError('runaway pagination', 500);
    } while (offset);

    return { records: all, lastModified };
  }

  /** A single BSO. */
  async getRecord(collection: string, id: string): Promise<BasicStorageObject> {
    return this.requestJson<BasicStorageObject>(
      'GET',
      `/storage/${collection}/${encodeURIComponent(id)}`,
      { collection },
    );
  }

  /** Fetch and JSON-parse the encrypted envelope of one record. */
  async getEncryptedRecord(
    collection: string,
    id: string,
  ): Promise<{ bso: BasicStorageObject; payload: EncryptedPayload }> {
    const bso = await this.getRecord(collection, id);
    return { bso, payload: JSON.parse(bso.payload) as EncryptedPayload };
  }

  // ------------------------------------------------------------------- writes

  /** `PUT` a single BSO. Returns the new collection timestamp. */
  async putRecord(
    collection: string,
    bso: BasicStorageObject,
    options: { unmodifiedSince?: number } = {},
  ): Promise<number> {
    const { text } = await this.request(
      'PUT',
      `/storage/${collection}/${encodeURIComponent(bso.id)}`,
      {
        body: { payload: bso.payload, ...(bso.sortindex !== undefined ? { sortindex: bso.sortindex } : {}), ...(bso.ttl !== undefined ? { ttl: bso.ttl } : {}) },
        collection,
        ...(options.unmodifiedSince !== undefined
          ? { unmodifiedSince: options.unmodifiedSince }
          : {}),
      },
    );
    return Number(text);
  }

  /**
   * `POST` a set of BSOs as an atomic batch.
   *
   * Splits into server-sized chunks, opens a batch on the first chunk, appends
   * with the returned batch id, and commits on the last one. If any chunk
   * fails the whole batch is discarded by the server, which is the behaviour we
   * want: a half-applied password collection is worse than no write at all.
   */
  async postRecordsBatched(
    collection: string,
    bsos: BasicStorageObject[],
    options: { unmodifiedSince?: number; config?: ServerConfiguration } = {},
  ): Promise<{ success: string[]; failed: Record<string, string>; modified: number | null }> {
    if (bsos.length === 0) return { success: [], failed: {}, modified: null };

    const maxRecords = options.config?.max_post_records ?? 100;
    const maxBytes = options.config?.max_post_bytes ?? 1_000_000;

    const chunks: BasicStorageObject[][] = [];
    let current: BasicStorageObject[] = [];
    let currentBytes = 0;
    for (const bso of bsos) {
      const size = JSON.stringify(bso).length;
      if (current.length >= maxRecords || (current.length > 0 && currentBytes + size > maxBytes)) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(bso);
      currentBytes += size;
    }
    if (current.length) chunks.push(current);

    const success: string[] = [];
    const failed: Record<string, string> = {};
    let batchId: string | undefined;
    let modified: number | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;
      const query: Record<string, string | undefined> = {};
      if (isFirst) query['batch'] = 'true';
      else if (batchId) query['batch'] = batchId;
      if (isLast) query['commit'] = 'true';

      const result = await this.requestJson<PostResponse>('POST', `/storage/${collection}`, {
        query,
        body: chunks[i],
        collection,
        ...(options.unmodifiedSince !== undefined
          ? { unmodifiedSince: options.unmodifiedSince }
          : {}),
      });

      success.push(...(result.success ?? []));
      Object.assign(failed, result.failed ?? {});
      if (result.batch) batchId = result.batch;
      if (result.modified !== undefined) modified = result.modified;
    }

    return { success, failed, modified };
  }

  /** Delete one record outright. Prefer a tombstone for synced collections. */
  async deleteRecord(collection: string, id: string): Promise<void> {
    await this.request('DELETE', `/storage/${collection}/${encodeURIComponent(id)}`, {
      collection,
    });
  }

  /** Delete a set of ids in one request. */
  async deleteRecords(collection: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.request('DELETE', `/storage/${collection}`, {
      query: { ids: ids.join(',') },
      collection,
    });
  }

  /** Delete a whole collection. */
  async deleteCollection(collection: string): Promise<void> {
    await this.request('DELETE', `/storage/${collection}`, { collection });
  }

  /** Wipe the entire Sync account. Guarded behind an explicit confirmation in the UI. */
  async deleteAllData(): Promise<void> {
    await this.request('DELETE', '/storage');
  }
}
