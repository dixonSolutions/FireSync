#!/usr/bin/env node
/**
 * FireSync build.
 *
 * esbuild bundles each entry point; everything lands flat in `dist/` so the
 * HTML pages can reference siblings by bare filename and the same file works
 * whether it is loaded as an extension page or as an overlay iframe.
 *
 * The content script is emitted as an IIFE, not an ES module: Chrome does not
 * support module content scripts.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const MODULE_ENTRIES = {
  background: 'src/background/index.ts',
  popup: 'src/ui/popup/popup.ts',
  unlock: 'src/ui/unlock/unlock.ts',
  onboarding: 'src/ui/onboarding/onboarding.ts',
  options: 'src/ui/options/options.ts',
  menu: 'src/ui/menu/menu.ts',
  'menu-button': 'src/ui/menu/button.ts',
  notification: 'src/ui/notification/notification.ts',
};

const IIFE_ENTRIES = {
  content: 'src/autofill/content.ts',
  'signin-relay': 'src/autofill/signin-relay.ts',
};

const HTML_PAGES = [
  ['src/ui/popup/popup.html', 'popup.html'],
  ['src/ui/unlock/unlock.html', 'unlock.html'],
  ['src/ui/onboarding/onboarding.html', 'onboarding.html'],
  ['src/ui/options/options.html', 'options.html'],
  ['src/ui/menu/menu.html', 'menu.html'],
  ['src/ui/menu/button.html', 'menu-button.html'],
  ['src/ui/notification/notification.html', 'notification.html'],
];

const shared = {
  bundle: true,
  target: ['chrome116'],
  logLevel: 'info',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

/**
 * A development build is deliberately a *different extension* from the release.
 *
 * `src/manifest.json` pins a `key`, which fixes the extension id — so an
 * unpacked build collides with the released CRX and Chromium will hold one or
 * the other, never both. That forces a choice nobody wants: keep the
 * auto-updating install, or test your own build.
 *
 * Dropping `key` gives the unpacked build a path-derived id instead, distinct
 * from the release, so the two sit side by side. `update_url` goes with it —
 * a local build must never be replaced by a download — and the name is marked
 * so the two are told apart in the toolbar and on chrome://extensions.
 */
async function emitManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  manifest.description = pkg.description.slice(0, 132);

  if (dev) {
    delete manifest.key;
    delete manifest.update_url;
    manifest.name = `${manifest.name} (dev)`;
    manifest.short_name = `${manifest.short_name} dev`;
    manifest.version_name = `${pkg.version}-dev`;
  }

  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyStatic() {
  await cp(join(root, 'src/ui/theme.css'), join(dist, 'theme.css'));
  for (const [from, to] of HTML_PAGES) {
    await cp(join(root, from), join(dist, to));
  }
  const icons = join(root, 'assets/icons');
  if (existsSync(icons)) {
    await mkdir(join(dist, 'icons'), { recursive: true });
    for (const file of await readdir(icons)) {
      if (file.endsWith('.png')) await cp(join(icons, file), join(dist, 'icons', file));
    }
  } else {
    console.warn('! assets/icons is missing — run `npm run assets` first');
  }
  // The extension's own pages draw the mark from the SVG rather than a PNG, so
  // it stays sharp at whatever size each surface asks for. These are the same
  // files `npm run assets` renders the PNGs from; shipping them keeps one
  // source of truth for the logo instead of a second copy inside the CSS.
  await mkdir(join(dist, 'icons'), { recursive: true });
  for (const file of ['icon.svg', 'icon-small.svg']) {
    const from = join(root, 'assets', file);
    if (existsSync(from)) await cp(from, join(dist, 'icons', file));
    else console.warn(`! assets/${file} is missing — the brand mark will not render`);
  }
}

async function run() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const configs = [
    {
      ...shared,
      entryPoints: Object.fromEntries(
        Object.entries(MODULE_ENTRIES).map(([name, file]) => [name, join(root, file)]),
      ),
      outdir: dist,
      format: 'esm',
      splitting: false,
    },
    {
      ...shared,
      entryPoints: Object.fromEntries(
        Object.entries(IIFE_ENTRIES).map(([name, file]) => [name, join(root, file)]),
      ),
      outdir: dist,
      format: 'iife',
    },
  ];

  if (watch) {
    for (const config of configs) {
      const ctx = await context(config);
      await ctx.watch();
    }
    await emitManifest();
    await copyStatic();
    console.log('watching…');
    return;
  }

  for (const config of configs) await build(config);
  await emitManifest();
  await copyStatic();

  const files = (await readdir(dist)).sort();
  console.log(`\nbuilt ${files.length} files into dist/`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
