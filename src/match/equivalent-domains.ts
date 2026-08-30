/**
 * Groups of domains that are genuinely the same login for the same user.
 *
 * This list is a usability feature with a security cost: every entry says
 * "offering a credential saved on A while the user is on B is acceptable". It
 * is therefore short, hand-audited, and limited to services that share a single
 * identity provider. Users can add their own groups per-site, and those are
 * never merged into this list.
 */

export const EQUIVALENT_DOMAIN_GROUPS: readonly (readonly string[])[] = [
  ['google.com', 'youtube.com', 'gmail.com', 'googlemail.com', 'google.co.uk'],
  ['microsoft.com', 'live.com', 'outlook.com', 'hotmail.com', 'office.com', 'microsoftonline.com'],
  ['apple.com', 'icloud.com'],
  ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp'],
  ['facebook.com', 'messenger.com'],
  ['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.com.au'],
  ['paypal.com', 'paypal.co.uk'],
  ['atlassian.com', 'atlassian.net', 'jira.com', 'bitbucket.org', 'trello.com'],
  ['github.com', 'githubusercontent.com'],
  ['zoom.us', 'zoom.com'],
  ['adobe.com', 'adobelogin.com'],
  ['steampowered.com', 'steamcommunity.com'],
  ['nytimes.com', 'nyt.com'],
];

/** Build the lookup once at module load. */
const DOMAIN_TO_GROUP = new Map<string, readonly string[]>();
for (const group of EQUIVALENT_DOMAIN_GROUPS) {
  for (const domain of group) DOMAIN_TO_GROUP.set(domain, group);
}

/** Every registrable domain considered equivalent to `domain`, including itself. */
export function equivalentDomains(domain: string, extra: readonly string[] = []): Set<string> {
  const result = new Set<string>([domain, ...extra]);
  for (const known of [domain, ...extra]) {
    for (const member of DOMAIN_TO_GROUP.get(known) ?? []) result.add(member);
  }
  return result;
}
