# Development

## Setup

```bash
npm install
npm run assets      # rasterise icons from assets/*.svg with headless Chrome
npm run build       # bundle into dist/
npm test
```

Node 20+ for the extension build; Node 22.5+ if you want to work on the bridge, which needs
`node:sqlite`.

| Command | What it does |
|---|---|
| `npm run build` | esbuild → `dist/`, flat, minified |
| `npm run build:watch` | Same, rebuilding on change |
| `npm run typecheck` | `tsc --noEmit`, strict, with `noUncheckedIndexedAccess` |
| `npm test` | Vitest, 328 tests, no network |
| `npm run coverage` | v8 coverage over `src/` and `bridge/` |
| `npm run assets` | SVG → PNG at 16/32/48/128/256/512 plus the banner |
| `npm run psl` | Regenerate the full Public Suffix List |
| `npm run pack` | Sign a CRX and emit `update.xml` |
| `npm run release` | typecheck + test + build + pack |

## Loading it

`chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

Chromium is the least friction; see [DISTRIBUTION.md](DISTRIBUTION.md) for why stock Chrome
is fussier.

## Debugging

| What | Where |
|---|---|
| Service worker | `chrome://extensions` → FireSync → **service worker** |
| Content script | The page's own DevTools console, in the FireSync isolated world |
| Overlay iframes | Right-click the overlay → Inspect; it is a separate extension-origin frame |
| Popup / options | Right-click → Inspect |
| Storage | Service-worker console: `await chrome.storage.local.get(null)` |
| Bridge | `node bridge/host.mjs --self-test` |

The service worker dies after ~30 seconds idle, which makes DevTools look broken. Clicking
**service worker** wakes it. If a message handler seems to never run, check whether the
worker restarted mid-flight — module state does not survive.

## Conventions

**Layering.** Nothing in `src/common`, `src/fxa`, `src/sync15`, `src/vault`, `src/match` or
`src/prefs` may import `chrome.*` directly. Storage goes through `src/common/storage.ts`.
This is what lets the whole protocol stack run under Node in tests, and it is worth
protecting.

**Errors carry meaning.** `FxAError` exposes `errno` and named predicates
(`needsUnblockCode`, `isRateLimited`); `SyncStorageError` carries the status;
`ConflictError` carries the server timestamp. Callers branch on those, never on message text.

**Fail closed.** Every matching, verification and validation function returns "no" on
anything it does not understand.

**Comments explain why.** Anything surprising — the base64-text HMAC, the `0x04 0x0e` IV
prefix, `X-If-Unmodified-Since` using the post-pull timestamp — carries a comment saying
what breaks without it. Anything obvious carries none.

## Adding a sync engine

1. Add `src/sync15/engines/<name>.ts`: the record type, a validator, and an authority-time
   function.
2. Register it in `AUTHORITY` and `COLLECTION_NAME` in `src/sync15/engine.ts`, and add the
   name to `SyncCollectionName` in `src/vault/types.ts`.
3. Give `VaultContents` a slot for it in `src/vault/types.ts`.
4. Add a flag under `engines` in `src/prefs/types.ts` and a row in the options page.
5. Add tests: record validation, plus an end-to-end case in `test/engine.test.ts` using the
   fake Sync server.

The engine loop itself needs no changes — it is generic over collection name, key bundle and
authority function.

## Adding a bridge method

1. Extend `BridgeRequest` and `BridgeResultMap` in `src/bridge/protocol.ts`.
2. Add a case to `handle()` in `bridge/host.mjs`, validating every field before use.
3. Add a method to `BridgeClient`.
4. Bump `BRIDGE_PROTOCOL_VERSION` only if an existing shape changed — the client refuses a
   host whose version does not match.

## Release checklist

1. `npm run release` — typecheck, tests, build, sign.
2. Bump `version` in `package.json` (the manifest inherits it at build time).
3. Update `CHANGELOG.md`.
4. Upload `build/firesync-<version>.crx`, update `build/update.xml`'s `version` and
   `codebase`, publish both.
5. Confirm an existing install picks the update up (Chrome checks roughly every 5 hours;
   `chrome://extensions` → **Update** forces it).
