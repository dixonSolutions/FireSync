#!/usr/bin/env node
/**
 * Package `dist/` into a signed CRX3 and emit the matching update manifest.
 *
 * The signing key lives at `keys/firesync.pem` and must never change: the
 * extension id is derived from it, and Chrome refuses an update signed with a
 * different key. Keep it out of the repository (it is gitignored) and back it
 * up somewhere you would be comfortable keeping an SSH key.
 */

import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const keyDir = join(root, 'keys');
const keyPath = process.env.FIRESYNC_KEY ?? join(keyDir, 'firesync.pem');
const outDir = join(root, 'build');

const UPDATE_BASE =
  process.env.FIRESYNC_UPDATE_BASE ?? 'https://example.invalid/firesync';

function chrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
  ].filter(Boolean)) {
    try {
      execFileSync('which', [candidate], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('no Chrome/Chromium found; set CHROME_BIN');
}

/** Chrome derives the extension id from the SHA-256 of the SPKI public key. */
function extensionIdFor(spkiDer) {
  const hash = createHash('sha256').update(spkiDer).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = hash[i];
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/ is empty — run `npm run build` first');
  process.exit(1);
}

mkdirSync(keyDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const packArgs = [`--pack-extension=${dist}`, '--no-sandbox'];
if (existsSync(keyPath)) packArgs.push(`--pack-extension-key=${keyPath}`);

execFileSync(chrome(), packArgs, { stdio: ['ignore', 'inherit', 'inherit'] });

// Chrome writes <dist>.crx / <dist>.pem next to the directory it packed.
const producedCrx = `${dist}.crx`;
const producedPem = `${dist}.pem`;
if (!existsSync(keyPath) && existsSync(producedPem)) {
  copyFileSync(producedPem, keyPath);
  console.log(`\ngenerated a new signing key at ${keyPath} — back this up.`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const crxName = `firesync-${pkg.version}.crx`;
copyFileSync(producedCrx, join(outDir, crxName));

const spki = createPublicKey(readFileSync(keyPath)).export({ type: 'spki', format: 'der' });
const id = extensionIdFor(spki);
const publicKeyB64 = spki.toString('base64');

writeFileSync(
  join(outDir, 'update.xml'),
  `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${UPDATE_BASE}/${crxName}' version='${pkg.version}' />
  </app>
</gupdate>
`,
);

writeFileSync(
  join(outDir, 'extension-id.txt'),
  `${id}\n\nAdd this to src/manifest.json so an unpacked load keeps the same id:\n\n  "key": "${publicKeyB64}"\n`,
);

console.log(`
  extension id : ${id}
  crx          : build/${crxName}
  update.xml   : build/update.xml  (codebase base: ${UPDATE_BASE})

Next: publish both files over HTTPS and point the enterprise policy in
packaging/ at build/update.xml. See docs/DISTRIBUTION.md.
`);
