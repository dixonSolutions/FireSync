#!/usr/bin/env node
/**
 * Rasterise the SVG brand assets with headless Chrome.
 *
 * ImageMagick's built-in SVG renderer mangles gradients and text, and
 * librsvg/Inkscape are not guaranteed to be installed. Chrome is — this is a
 * Chrome extension — and it renders exactly what the extension will show.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, 'assets');
const iconsDir = join(assets, 'icons');

const CANDIDATES = [
  process.env.CHROME_BIN,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const candidate of CANDIDATES) {
    try {
      execFileSync('which', [candidate], { stdio: 'ignore' });
      return candidate;
    } catch {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `no Chrome/Chromium found. Set CHROME_BIN, or install one of: ${CANDIDATES.join(', ')}`,
  );
}

function shot(chrome, { svg, out, width, height, transparent }) {
  const work = join(tmpdir(), `firesync-render-${process.pid}-${width}x${height}`);
  mkdirSync(work, { recursive: true });
  const page = join(work, 'page.html');
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;
       background:${transparent ? 'transparent' : '#141419'}}
       svg{display:block;width:${width}px;height:${height}px}
     </style>${readFileSync(svg, 'utf8')}`,
  );

  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      ...(transparent ? ['--default-background-color=00000000'] : []),
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  rmSync(work, { recursive: true, force: true });
  console.log(`  ${out.replace(`${root}/`, '')}  ${width}x${height}`);
}

const chrome = findChrome();
console.log(`rendering with ${chrome}`);
mkdirSync(iconsDir, { recursive: true });

/**
 * Small sizes use a simplified mark. The full one's sync ring is under a device
 * pixel wide at 16px and renders as a halo, so 16 and 32 get a variant with just
 * the flame. Verified by eye at 1:1 rather than assumed.
 */
const SMALL_SIZES = new Set([16, 32]);

for (const size of [16, 32, 48, 128, 256, 512]) {
  shot(chrome, {
    svg: join(assets, SMALL_SIZES.has(size) ? 'icon-small.svg' : 'icon.svg'),
    out: join(iconsDir, `icon-${size}.png`),
    width: size,
    height: size,
    transparent: true,
  });
}

shot(chrome, {
  svg: join(assets, 'banner.svg'),
  out: join(assets, 'banner.png'),
  width: 1280,
  height: 640,
  transparent: false,
});

console.log('done');
