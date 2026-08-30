/**
 * Deciding whether a stored credential belongs to the page in front of us.
 *
 * This is the security boundary of the whole autofill feature. Every rule here
 * fails closed: an unparseable URL, a scheme mismatch, or an unknown strategy
 * yields "no match" rather than "probably fine".
 */

import { equivalentDomains } from './equivalent-domains.ts';
import { normalizeHost, registrableDomain } from './psl.ts';
import type { UriMatchStrategy } from '../prefs/types.ts';

export interface MatchContext {
  strategy?: UriMatchStrategy;
  /** Extra origins the user marked equivalent for this site. */
  extraEquivalentDomains?: readonly string[];
  /** User-supplied pattern, only consulted when strategy is `regex`. */
  pattern?: string;
}

export interface ParsedTarget {
  url: URL;
  host: string;
  domain: string | null;
  origin: string;
}

/** Parse a URL into the pieces matching needs, or null if it is unusable. */
export function parseTarget(input: string): ParsedTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = normalizeHost(url.hostname);
  if (!host) return null;
  return { url, host, domain: registrableDomain(host), origin: url.origin };
}

/**
 * Whether a credential stored for `storedOrigin` may be offered on `pageUrl`.
 *
 * The `domain` strategy — the default — additionally refuses to offer an
 * https-only credential on a plain-http page. Downgrade attacks are cheap and a
 * password manager that fills over http has handed the password to the network.
 */
export function originMatches(
  storedOrigin: string,
  pageUrl: string,
  context: MatchContext = {},
): boolean {
  const strategy = context.strategy ?? 'domain';
  if (strategy === 'never') return false;

  const stored = parseTarget(storedOrigin);
  const page = parseTarget(pageUrl);
  if (!stored || !page) return false;

  switch (strategy) {
    case 'exact':
      return stored.url.href.replace(/\/$/, '') === page.url.href.replace(/\/$/, '');

    case 'host':
      return stored.host === page.host && schemeIsAcceptable(stored, page);

    case 'startsWith':
      return (
        page.url.href.startsWith(stored.url.href.replace(/\/$/, '')) &&
        schemeIsAcceptable(stored, page)
      );

    case 'regex': {
      if (!context.pattern) return false;
      let regex: RegExp;
      try {
        regex = new RegExp(context.pattern);
      } catch {
        return false;
      }
      return regex.test(page.url.href);
    }

    case 'domain':
    default: {
      if (!stored.domain || !page.domain) {
        // No registrable domain (IP literal, localhost): require exact host.
        return stored.host === page.host && schemeIsAcceptable(stored, page);
      }
      if (!schemeIsAcceptable(stored, page)) return false;
      const allowed = equivalentDomains(stored.domain, context.extraEquivalentDomains);
      return allowed.has(page.domain);
    }
  }
}

/**
 * Never fill an https-saved credential into an http page. The reverse (an
 * http-saved credential on https) is an upgrade and is allowed.
 */
function schemeIsAcceptable(stored: ParsedTarget, page: ParsedTarget): boolean {
  if (stored.url.protocol === 'https:' && page.url.protocol === 'http:') return false;
  return true;
}

/**
 * Rank matching credentials so the most specific one is pre-selected.
 * Higher is better.
 */
export function matchScore(storedOrigin: string, pageUrl: string): number {
  const stored = parseTarget(storedOrigin);
  const page = parseTarget(pageUrl);
  if (!stored || !page) return 0;

  let score = 0;
  if (stored.domain && page.domain && stored.domain === page.domain) score += 10;
  if (stored.host === page.host) score += 20;
  if (stored.origin === page.origin) score += 30;
  if (stored.url.protocol === page.url.protocol) score += 5;
  return score;
}

/**
 * The origin string to store for a page, normalised the way Firefox does it:
 * scheme + host + non-default port, and nothing else.
 */
export function originForStorage(pageUrl: string): string | null {
  const target = parseTarget(pageUrl);
  return target ? target.origin : null;
}
