import { describe, expect, it } from 'vitest';
import {
  calculateMac,
  calculatePayloadHash,
  hawkHeader,
  normalizeString,
} from '../src/common/hawk.ts';

/** The canonical example credentials from the Hawk specification. */
const CREDENTIALS = {
  id: 'dh37fgj492je',
  key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn',
  algorithm: 'sha256' as const,
};

describe('Hawk normalized string', () => {
  it('matches the spec layout exactly', () => {
    const normalized = normalizeString({
      ts: 1353832234,
      nonce: 'j4h3g2',
      method: 'GET',
      resource: '/resource/1?b=1&a=2',
      host: 'example.com',
      port: 8000,
      hash: '',
      ext: 'some-app-ext-data',
    });
    expect(normalized).toBe(
      'hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n8000\n\nsome-app-ext-data\n',
    );
  });

  it('escapes backslashes and newlines in ext', () => {
    const normalized = normalizeString({
      ts: 1,
      nonce: 'n',
      method: 'GET',
      resource: '/',
      host: 'h',
      port: 443,
      hash: '',
      ext: 'a\\b\nc',
    });
    expect(normalized.split('\n')[8]).toBe('a\\\\b\\nc');
  });

  it('lower-cases the host and upper-cases the method', () => {
    const normalized = normalizeString({
      ts: 1,
      nonce: 'n',
      method: 'get',
      resource: '/',
      host: 'EXAMPLE.com',
      port: 443,
      hash: '',
      ext: '',
    });
    expect(normalized).toContain('\nGET\n');
    expect(normalized).toContain('\nexample.com\n');
  });
});

describe('Hawk MAC (spec vectors)', () => {
  it('signs the GET example', async () => {
    const mac = await calculateMac(CREDENTIALS, {
      ts: 1353832234,
      nonce: 'j4h3g2',
      method: 'GET',
      resource: '/resource/1?b=1&a=2',
      host: 'example.com',
      port: 8000,
      hash: '',
      ext: 'some-app-ext-data',
    });
    expect(mac).toBe('6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=');
  });

  it('hashes the payload example', async () => {
    const hash = await calculatePayloadHash('Thank you for flying Hawk', 'text/plain');
    expect(hash).toBe('Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=');
  });

  it('signs the POST-with-payload example', async () => {
    const hash = await calculatePayloadHash('Thank you for flying Hawk', 'text/plain');
    const mac = await calculateMac(CREDENTIALS, {
      ts: 1353832234,
      nonce: 'j4h3g2',
      method: 'POST',
      resource: '/resource/1?b=1&a=2',
      host: 'example.com',
      port: 8000,
      hash,
      ext: 'some-app-ext-data',
    });
    expect(mac).toBe('aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=');
  });

  it('strips content-type parameters before hashing', async () => {
    const bare = await calculatePayloadHash('{}', 'application/json');
    const withParams = await calculatePayloadHash('{}', 'Application/JSON; charset=UTF-8');
    expect(withParams).toBe(bare);
  });
});

describe('hawkHeader', () => {
  it('produces the full header for the GET example', async () => {
    const { header } = await hawkHeader({
      method: 'GET',
      url: 'http://example.com:8000/resource/1?b=1&a=2',
      credentials: CREDENTIALS,
      ext: 'some-app-ext-data',
      ts: 1353832234,
      nonce: 'j4h3g2',
    });
    expect(header).toBe(
      'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ' +
        'ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="',
    );
  });

  it('includes a payload hash when a body is present', async () => {
    const { header, artifacts } = await hawkHeader({
      method: 'POST',
      url: 'https://api.accounts.firefox.com/v1/account/device',
      credentials: CREDENTIALS,
      payload: '{"name":"FireSync"}',
      contentType: 'application/json',
      ts: 1700000000,
      nonce: 'abcd',
    });
    expect(artifacts.hash).not.toBe('');
    expect(header).toContain('hash="');
    expect(artifacts.port).toBe(443);
    expect(artifacts.resource).toBe('/v1/account/device');
  });

  it('omits the payload hash for bodyless requests', async () => {
    const { header } = await hawkHeader({
      method: 'GET',
      url: 'https://api.accounts.firefox.com/v1/account/keys',
      credentials: CREDENTIALS,
      ts: 1700000000,
      nonce: 'abcd',
    });
    expect(header).not.toContain('hash="');
    expect(header).not.toContain('ext="');
  });

  it('defaults the port from the scheme and keeps the query string', async () => {
    const { artifacts } = await hawkHeader({
      method: 'GET',
      url: 'https://sync.example.com/1.5/9/storage/passwords?full=1&newer=1.5',
      credentials: CREDENTIALS,
      ts: 1,
      nonce: 'n',
    });
    expect(artifacts.port).toBe(443);
    expect(artifacts.resource).toBe('/1.5/9/storage/passwords?full=1&newer=1.5');
  });

  it('applies a learned clock offset', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { artifacts } = await hawkHeader({
      method: 'GET',
      url: 'https://example.com/',
      credentials: CREDENTIALS,
      localtimeOffsetSec: 120,
    });
    expect(artifacts.ts).toBeGreaterThanOrEqual(now + 119);
    expect(artifacts.ts).toBeLessThanOrEqual(now + 122);
  });

  it('rejects unsupported algorithms', async () => {
    await expect(
      hawkHeader({
        method: 'GET',
        url: 'https://example.com/',
        credentials: { ...CREDENTIALS, algorithm: 'sha1' as unknown as 'sha256' },
      }),
    ).rejects.toThrow(/unsupported Hawk algorithm/);
  });
});
