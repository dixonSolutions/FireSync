import { describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  StorageAuthError,
  SyncStorageClient,
  SyncStorageError,
} from '../src/sync15/storage.ts';
import type { BasicStorageObject } from '../src/sync15/storage.ts';

const ENDPOINT = 'https://sync.example.test/1.5/9';
const CREDENTIALS = { id: 'hawk-id', key: 'hawk-key', algorithm: 'sha256' as const };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function harness(
  responder: (call: Call) => Response | Promise<Response>,
): { client: SyncStorageClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new SyncStorageClient({
    endpoint: ENDPOINT,
    credentials: CREDENTIALS,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responder({ url, init });
    },
  });
  return { client, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('request signing', () => {
  it('sends a Hawk Authorization header on every request', async () => {
    const { client, calls } = harness(() => json({}));
    await client.infoCollections();
    const header = (calls[0]?.init?.headers as Record<string, string>)['authorization'];
    expect(header).toMatch(/^Hawk id="hawk-id", ts="\d+", nonce="[0-9a-f]+", mac="/);
  });

  it('includes a payload hash when there is a body', async () => {
    const { client, calls } = harness(() => json({ success: ['a'], failed: {}, modified: 1 }));
    await client.putRecord('passwords', { id: 'a', payload: '{}' });
    const header = (calls[0]?.init?.headers as Record<string, string>)['authorization'];
    expect(header).toContain('hash="');
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('learns the clock offset from X-Weave-Timestamp', async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const { client } = harness(() => json({}, 200, { 'x-weave-timestamp': String(future) }));
    await client.infoCollections();
    expect(client.clockOffsetSeconds).toBeGreaterThan(500);
  });
});

describe('reads', () => {
  it('requests only ids unless full is set', async () => {
    const { client, calls } = harness(() => json(['a', 'b']));
    const page = await client.getCollection('passwords');
    expect(calls[0]?.url).not.toContain('full=');
    expect(page.records.map((record) => record.id)).toEqual(['a', 'b']);
  });

  it('passes newer, limit, sort and ids through', async () => {
    const { client, calls } = harness(() => json([]));
    await client.getCollection('passwords', {
      full: true,
      newer: 1234.5,
      limit: 50,
      sort: 'oldest',
      ids: ['a', 'b'],
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('full')).toBe('1');
    expect(url.searchParams.get('newer')).toBe('1234.5');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('sort')).toBe('oldest');
    expect(url.searchParams.get('ids')).toBe('a,b');
  });

  it('follows X-Weave-Next-Offset until the collection is exhausted', async () => {
    let page = 0;
    const { client, calls } = harness(() => {
      page += 1;
      if (page === 1) {
        return json([{ id: 'a', payload: '{}' }], 200, {
          'x-weave-next-offset': '2',
          'x-last-modified': '100',
        });
      }
      return json([{ id: 'b', payload: '{}' }], 200, { 'x-last-modified': '100' });
    });

    const result = await client.getAllRecords('passwords');
    expect(result.records.map((record) => record.id)).toEqual(['a', 'b']);
    expect(result.lastModified).toBe(100);
    expect(new URL(calls[1]!.url).searchParams.get('offset')).toBe('2');
  });

  it('gives up rather than paginating forever', async () => {
    const { client } = harness(() =>
      json([{ id: 'a', payload: '{}' }], 200, { 'x-weave-next-offset': '1' }),
    );
    await expect(client.getAllRecords('passwords')).rejects.toThrow(/runaway pagination/);
  });

  it('tracks the last-modified timestamp per collection', async () => {
    const { client } = harness(() => json([], 200, { 'x-last-modified': '4242.5' }));
    await client.getCollection('passwords', { full: true });
    expect(client.lastModifiedFor('passwords')).toBe(4242.5);
    expect(client.lastModifiedFor('addresses')).toBeUndefined();
  });

  it('parses an encrypted record envelope', async () => {
    const payload = { ciphertext: 'c', IV: 'i', hmac: 'h' };
    const { client } = harness(() => json({ id: 'keys', payload: JSON.stringify(payload) }));
    const result = await client.getEncryptedRecord('crypto', 'keys');
    expect(result.payload).toEqual(payload);
  });
});

describe('writes', () => {
  it('sends X-If-Unmodified-Since when asked', async () => {
    const { client, calls } = harness(() => new Response('1234.56'));
    await client.putRecord('passwords', { id: 'a', payload: '{}' }, { unmodifiedSince: 999 });
    expect((calls[0]?.init?.headers as Record<string, string>)['x-if-unmodified-since']).toBe(
      '999',
    );
  });

  it('raises ConflictError on 412 and reports the server timestamp', async () => {
    const { client } = harness(() => json({}, 412, { 'x-last-modified': '5555' }));
    await expect(
      client.putRecord('passwords', { id: 'a', payload: '{}' }),
    ).rejects.toMatchObject({ name: 'ConflictError', serverLastModified: 5555 });
  });

  it('raises StorageAuthError on 401', async () => {
    const { client } = harness(() => json({}, 401));
    await expect(client.infoCollections()).rejects.toBeInstanceOf(StorageAuthError);
  });

  it('surfaces other failures with the status and a body excerpt', async () => {
    const { client } = harness(() => new Response('server exploded', { status: 500 }));
    await expect(client.infoCollections()).rejects.toMatchObject({
      name: 'SyncStorageError',
      status: 500,
      responseBody: 'server exploded',
    });
  });

  it('batches uploads according to the server configuration', async () => {
    const seen: URL[] = [];
    const { client } = harness(({ url }) => {
      seen.push(new URL(url));
      const bodies = JSON.parse(String(seen.length)) as number;
      void bodies;
      return json({ success: ['x'], failed: {}, batch: 'b1', modified: 10 });
    });

    const records: BasicStorageObject[] = Array.from({ length: 5 }, (_, index) => ({
      id: `id-${index}`,
      payload: '{}',
    }));

    await client.postRecordsBatched('passwords', records, {
      config: { max_post_records: 2, max_post_bytes: 100_000 },
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]?.searchParams.get('batch')).toBe('true');
    expect(seen[1]?.searchParams.get('batch')).toBe('b1');
    expect(seen[2]?.searchParams.get('commit')).toBe('true');
  });

  it('splits on byte size as well as record count', async () => {
    let posts = 0;
    const { client } = harness(() => {
      posts += 1;
      return json({ success: [], failed: {}, modified: 1 });
    });

    const big = 'x'.repeat(400);
    await client.postRecordsBatched(
      'passwords',
      Array.from({ length: 4 }, (_, index) => ({ id: `${index}`, payload: big })),
      { config: { max_post_records: 100, max_post_bytes: 900 } },
    );
    expect(posts).toBeGreaterThan(1);
  });

  it('does nothing for an empty upload', async () => {
    const fetchImpl = vi.fn();
    const client = new SyncStorageClient({
      endpoint: ENDPOINT,
      credentials: CREDENTIALS,
      fetchImpl: fetchImpl as never,
    });
    await expect(client.postRecordsBatched('passwords', [])).resolves.toEqual({
      success: [],
      failed: {},
      modified: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deletes by id list', async () => {
    const { client, calls } = harness(() => new Response('1'));
    await client.deleteRecords('passwords', ['a', 'b']);
    expect(new URL(calls[0]!.url).searchParams.get('ids')).toBe('a,b');
  });

  it('skips the request when there is nothing to delete', async () => {
    const { client, calls } = harness(() => new Response('1'));
    await client.deleteRecords('passwords', []);
    expect(calls).toHaveLength(0);
  });
});

describe('backoff', () => {
  it('records X-Weave-Backoff and then refuses further requests', async () => {
    const { client } = harness(() => json({}, 200, { 'x-weave-backoff': '30' }));
    await client.infoCollections();
    expect(client.backoffUntilMs).toBeGreaterThan(Date.now());
    await expect(client.infoCollections()).rejects.toThrow(/server backoff in effect/);
  });

  it('honours Retry-After on a 503', async () => {
    const { client } = harness(() => json({}, 503, { 'retry-after': '120' }));
    await expect(client.infoCollections()).rejects.toBeInstanceOf(SyncStorageError);
    expect(client.backoffUntilMs).toBeGreaterThan(Date.now() + 100_000);
  });
});
