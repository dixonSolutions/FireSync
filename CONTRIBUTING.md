# Contributing

## Before a pull request

```bash
npm run typecheck && npm test && npm run build
```

All three must pass. `npm run release` does them plus signing.

## What a change needs

**A test that fails without it.** Every bug fix gets a regression test. Two of the three
real bugs found so far were caught by tests written before a browser ran the code, and both
would have been invisible in manual testing.

**A comment where it is surprising.** If a reader would ask "why is it done this way?",
answer it in the code. If they would not, say nothing.

**Honest documentation.** If a change makes something less safe, less complete or less
certain, say so in the relevant doc. A README that oversells a password manager is worse
than no README.

## Layering

Nothing in `src/common`, `src/fxa`, `src/sync15`, `src/vault`, `src/match` or `src/prefs`
may import `chrome.*`. Storage goes through `src/common/storage.ts`. This is what keeps the
protocol stack testable under Node, and it is easy to break by accident.

## Security-sensitive areas

Changes to these get read closely, and need a test for the failure case as well as the
success case:

- `src/match/uri.ts` and `src/match/psl.ts` — a permissive bug here discloses credentials to
  the wrong site.
- `src/vault/crypto.ts` — at-rest encryption.
- `src/fxa/onepw.ts` and `src/sync15/crypto.ts` — key derivation and record verification.
- `src/autofill/overlay.ts` — the boundary between the page and the extension.
- `bridge/` — a local process handling an entire password store.

If you are not sure whether something is sensitive, assume it is.

## Reporting a vulnerability

Open a **private** security advisory, or email the maintainers. Please do not open a public
issue for anything that would let someone read another person's vault. See
[docs/SECURITY.md](docs/SECURITY.md).

## Style

Prettier defaults, 100 columns, single quotes, trailing commas. TypeScript strict with
`noUncheckedIndexedAccess`. Commit messages in the imperative mood, with a body explaining
why when the diff does not.

## Things that will be declined

- A FireSync server, or anything that puts a third party in the data path.
- Writing to Chrome's own `Login Data` store.
- Loosening URI matching for convenience.
- Making the bridge required.
- Large dependencies in the extension bundle. There are currently none at runtime, and that
  is a feature of a program that holds passwords.
