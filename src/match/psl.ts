/**
 * A compact Public Suffix List.
 *
 * Registrable-domain ("eTLD+1") computation decides whether a stored
 * credential is offered on a page. Getting it wrong in the permissive
 * direction is a credential-disclosure bug — `evil.co.uk` must never look like
 * the same site as `bank.co.uk` — so this is done properly rather than with a
 * substring check.
 *
 * Bundled here is the multi-label subset that actually matters: every rule with
 * more than one label, plus the wildcard and exception rules. Single-label TLDs
 * (`com`, `dev`, `xyz`, …) need no entry — they are covered by the default
 * "*" rule in the algorithm.
 *
 * `npm run psl` regenerates `psl-generated.ts` from publicsuffix.org for a
 * complete list; this file is the offline fallback and what the tests run
 * against.
 */

/** Multi-label suffixes: an exact match makes the whole string a public suffix. */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk',
  'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
  // Ireland / Europe
  'gov.ie', 'co.at', 'or.at', 'ac.at', 'gv.at', 'com.de', 'com.es', 'nom.es',
  'org.es', 'gob.es', 'edu.es', 'com.pl', 'net.pl', 'org.pl', 'edu.pl',
  'gov.pl', 'waw.pl', 'krakow.pl', 'wroc.pl', 'gda.pl', 'poznan.pl',
  'com.pt', 'edu.pt', 'gov.pt', 'org.pt', 'com.gr', 'edu.gr', 'net.gr',
  'org.gr', 'gov.gr', 'com.ro', 'org.ro', 'gov.ro', 'com.hr', 'com.ua',
  'net.ua', 'org.ua', 'com.cy', 'com.mt', 'co.rs', 'org.rs', 'com.se',
  'org.se', 'priv.no', 'co.no',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'com.ar', 'net.ar',
  'org.ar', 'gob.ar', 'com.mx', 'org.mx', 'gob.mx', 'edu.mx', 'com.co',
  'net.co', 'gov.co', 'edu.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  'gc.ca', 'on.ca', 'qc.ca', 'bc.ca', 'ab.ca',
  // Asia-Pacific
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp',
  'lg.jp', 'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr', 'pe.kr', 'ac.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk',
  'org.hk', 'edu.hk', 'gov.hk', 'idv.hk', 'com.tw', 'org.tw', 'edu.tw',
  'gov.tw', 'net.tw', 'com.sg', 'edu.sg', 'gov.sg', 'org.sg', 'per.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my', 'com.ph', 'net.ph',
  'org.ph', 'gov.ph', 'co.th', 'in.th', 'ac.th', 'go.th', 'or.th',
  'co.id', 'web.id', 'or.id', 'ac.id', 'go.id', 'com.vn', 'edu.vn',
  'gov.vn', 'net.vn', 'org.vn', 'co.in', 'net.in', 'org.in', 'gen.in',
  'firm.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in', 'com.pk',
  'com.bd', 'com.np', 'com.lk', 'com.au', 'net.au', 'org.au', 'edu.au',
  'gov.au', 'asn.au', 'id.au', 'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'ac.nz', 'school.nz', 'geek.nz', 'kiwi.nz',
  // Middle East & Africa
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'co.za', 'org.za',
  'net.za', 'gov.za', 'ac.za', 'web.za', 'com.ng', 'com.gh', 'co.ke',
  'or.ke', 'ac.ke', 'com.eg', 'com.sa', 'com.tr', 'net.tr', 'org.tr',
  'gov.tr', 'edu.tr', 'com.ae', 'ae.org', 'com.qa', 'com.kw',
  // United States & generic seconds
  'com.us', 'org.us', 'gov.us', 'k12.ca.us', 'ny.us', 'ca.us',
  // Widely-used hosting suffixes where sites are genuinely separate origins
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'firebaseapp.com', 'web.app', 'herokuapp.com',
  'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com',
  'appspot.com', 'blogspot.com', 'wordpress.com', 'glitch.me', 'repl.co',
  'onrender.com', 'fly.dev', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
  'sharepoint.com', 'myshopify.com', 'zendesk.com', 'atlassian.net',
  'notion.site', 'squarespace.com', 'weebly.com', 'webflow.io',
]);

/** Wildcard rules: `*.<key>` — anything one level under the key is a suffix. */
export const WILDCARD_SUFFIXES: ReadonlySet<string> = new Set([
  'ck', 'er', 'jm', 'kh', 'mm', 'np', 'pg', 'bd', 'fj', 'et',
  'compute.amazonaws.com', 'compute-1.amazonaws.com', 'elb.amazonaws.com',
  'sk.ca', 'platform.sh', 'cdn.prod.atlassian-dev.net',
]);

/** Exception rules: these are NOT public suffixes despite a wildcard above. */
export const SUFFIX_EXCEPTIONS: ReadonlySet<string> = new Set(['www.ck']);

/** True when `host` is itself a public suffix (and so cannot hold a cookie). */
export function isPublicSuffix(host: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (SUFFIX_EXCEPTIONS.has(normalized)) return false;
  if (PUBLIC_SUFFIXES.has(normalized)) return true;

  const labels = normalized.split('.');
  if (labels.length === 1) return true; // bare TLD

  const parent = labels.slice(1).join('.');
  if (WILDCARD_SUFFIXES.has(parent)) return true;
  return false;
}

/**
 * The registrable domain (eTLD+1) of a hostname, or null when the host is an
 * IP address, a bare public suffix, or otherwise has no registrable part.
 */
export function registrableDomain(host: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  if (isIpAddress(normalized)) return normalized;

  const labels = normalized.split('.');
  if (labels.length < 2) return null;

  // Longest matching rule wins, per the PSL algorithm.
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (SUFFIX_EXCEPTIONS.has(candidate)) {
      // An exception rule means the candidate itself is registrable.
      return candidate;
    }
    if (PUBLIC_SUFFIXES.has(candidate)) {
      return i === 0 ? null : labels.slice(i - 1).join('.');
    }
    const parent = labels.slice(i + 1).join('.');
    if (parent && WILDCARD_SUFFIXES.has(parent)) {
      return i === 0 ? null : labels.slice(i - 1).join('.');
    }
  }

  // Default rule "*": the last label is the public suffix.
  return labels.slice(-2).join('.');
}

/** Lower-case, strip a trailing dot, strip brackets from IPv6 literals. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

export function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((octet) => Number(octet) <= 255);
  }
  return host.includes(':');
}
