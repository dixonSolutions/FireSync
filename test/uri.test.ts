import { describe, expect, it } from 'vitest';
import { isPublicSuffix, normalizeHost, registrableDomain } from '../src/match/psl.ts';
import { equivalentDomains } from '../src/match/equivalent-domains.ts';
import {
  matchScore,
  originForStorage,
  originMatches,
  parseTarget,
} from '../src/match/uri.ts';

describe('public suffix list', () => {
  it('finds the registrable domain for simple TLDs', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.c.example.com')).toBe('example.com');
    expect(registrableDomain('example.dev')).toBe('example.dev');
  });

  it('handles multi-label suffixes', () => {
    expect(registrableDomain('bank.co.uk')).toBe('bank.co.uk');
    expect(registrableDomain('secure.bank.co.uk')).toBe('bank.co.uk');
    expect(registrableDomain('shop.com.au')).toBe('shop.com.au');
    expect(registrableDomain('site.co.jp')).toBe('site.co.jp');
  });

  it('treats hosting suffixes as separate registrable domains', () => {
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
    expect(registrableDomain('bob.github.io')).toBe('bob.github.io');
    expect(registrableDomain('app.vercel.app')).toBe('app.vercel.app');
  });

  it('returns null for a bare public suffix', () => {
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('com')).toBeNull();
  });

  it('honours wildcard and exception rules', () => {
    expect(isPublicSuffix('foo.ck')).toBe(true);
    expect(isPublicSuffix('www.ck')).toBe(false);
    expect(registrableDomain('www.ck')).toBe('www.ck');
  });

  it('passes IP literals through unchanged', () => {
    expect(registrableDomain('192.168.1.10')).toBe('192.168.1.10');
    expect(registrableDomain('::1')).toBe('::1');
  });

  it('normalises trailing dots, case, and IPv6 brackets', () => {
    expect(normalizeHost('Example.COM.')).toBe('example.com');
    expect(normalizeHost('[::1]')).toBe('::1');
  });
});

describe('equivalent domains', () => {
  it('groups a known identity provider family', () => {
    const group = equivalentDomains('google.com');
    expect(group.has('youtube.com')).toBe(true);
    expect(group.has('gmail.com')).toBe(true);
    expect(group.has('example.com')).toBe(false);
  });

  it('always includes the domain itself', () => {
    expect(equivalentDomains('nowhere.test').has('nowhere.test')).toBe(true);
  });

  it('folds in user-supplied extras', () => {
    const group = equivalentDomains('example.com', ['example.net']);
    expect(group.has('example.net')).toBe(true);
  });
});

describe('originMatches — domain strategy (default)', () => {
  it('matches a subdomain of the same registrable domain', () => {
    expect(originMatches('https://example.com', 'https://login.example.com/signin')).toBe(true);
  });

  it('does NOT match a different registrable domain', () => {
    expect(originMatches('https://example.com', 'https://example.org/')).toBe(false);
  });

  it('does NOT match a lookalike sharing a public suffix', () => {
    expect(originMatches('https://bank.co.uk', 'https://evil.co.uk/')).toBe(false);
  });

  it('does NOT match a domain that merely contains the stored one', () => {
    expect(originMatches('https://example.com', 'https://example.com.evil.net/')).toBe(false);
  });

  it('does NOT match a prefix trick', () => {
    expect(originMatches('https://example.com', 'https://notexample.com/')).toBe(false);
  });

  it('matches equivalent domains from the bundled list', () => {
    expect(originMatches('https://google.com', 'https://www.youtube.com/')).toBe(true);
  });

  it('refuses to fill an https credential into an http page', () => {
    expect(originMatches('https://example.com', 'http://example.com/')).toBe(false);
  });

  it('allows an http credential on an https page', () => {
    expect(originMatches('http://example.com', 'https://example.com/')).toBe(true);
  });

  it('requires an exact host for IP literals and localhost', () => {
    expect(originMatches('http://127.0.0.1:8080', 'http://127.0.0.1:8080/app')).toBe(true);
    expect(originMatches('http://127.0.0.1:8080', 'http://127.0.0.2:8080/app')).toBe(false);
  });

  it('rejects non-http schemes outright', () => {
    expect(originMatches('https://example.com', 'file:///etc/passwd')).toBe(false);
    expect(originMatches('https://example.com', 'javascript:alert(1)')).toBe(false);
    expect(originMatches('chrome://settings', 'chrome://settings')).toBe(false);
  });

  it('rejects unparseable input', () => {
    expect(originMatches('nonsense', 'https://example.com/')).toBe(false);
    expect(originMatches('https://example.com', '')).toBe(false);
  });
});

describe('originMatches — other strategies', () => {
  it('host requires an exact hostname', () => {
    const context = { strategy: 'host' as const };
    expect(originMatches('https://example.com', 'https://example.com/x', context)).toBe(true);
    expect(originMatches('https://example.com', 'https://www.example.com/x', context)).toBe(false);
  });

  it('exact requires the whole URL', () => {
    const context = { strategy: 'exact' as const };
    expect(originMatches('https://example.com/a', 'https://example.com/a', context)).toBe(true);
    expect(originMatches('https://example.com/a', 'https://example.com/b', context)).toBe(false);
  });

  it('startsWith matches a path prefix', () => {
    const context = { strategy: 'startsWith' as const };
    expect(originMatches('https://example.com/app', 'https://example.com/app/page', context)).toBe(
      true,
    );
    expect(originMatches('https://example.com/app', 'https://example.com/other', context)).toBe(
      false,
    );
  });

  it('regex uses the user pattern and fails closed on a bad one', () => {
    expect(
      originMatches('https://example.com', 'https://a.example.com/', {
        strategy: 'regex',
        pattern: '^https://[a-z]+\\.example\\.com/',
      }),
    ).toBe(true);
    expect(
      originMatches('https://example.com', 'https://a.example.com/', {
        strategy: 'regex',
        pattern: '[',
      }),
    ).toBe(false);
    expect(
      originMatches('https://example.com', 'https://a.example.com/', { strategy: 'regex' }),
    ).toBe(false);
  });

  it('never disables the credential entirely', () => {
    expect(originMatches('https://example.com', 'https://example.com/', { strategy: 'never' })).toBe(
      false,
    );
  });
});

describe('matchScore', () => {
  it('ranks an exact origin above a host above a bare domain', () => {
    const page = 'https://login.example.com/signin';
    const exact = matchScore('https://login.example.com', page);
    const domain = matchScore('https://example.com', page);
    expect(exact).toBeGreaterThan(domain);
  });

  it('scores an unparseable origin as zero', () => {
    expect(matchScore('nope', 'https://example.com')).toBe(0);
  });
});

describe('parseTarget / originForStorage', () => {
  it('extracts host, domain and origin', () => {
    const target = parseTarget('https://Login.Example.co.uk:8443/path?x=1');
    expect(target?.host).toBe('login.example.co.uk');
    expect(target?.domain).toBe('example.co.uk');
    expect(target?.origin).toBe('https://login.example.co.uk:8443');
  });

  it('stores a bare origin', () => {
    expect(originForStorage('https://example.com/login?next=1')).toBe('https://example.com');
    expect(originForStorage('about:blank')).toBeNull();
  });
});
