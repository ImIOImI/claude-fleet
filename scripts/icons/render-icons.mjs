// Export every element in scripts/icons/icons.html to a transparent PNG.
// Not part of the build: run it after changing build-icons-html.mjs.
//   node scripts/icons/build-icons-html.mjs
//   npx -y -p puppeteer node scripts/icons/render-icons.mjs
// Outputs resources/icon.png (electron-builder derives .ico/.icns from it) and
// resources/presence/*.png (tray + taskbar overlay images, imported via ?asset).
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const puppeteer = (await import(process.env.PUPPETEER_MODULE ?? 'puppeteer')).default;
const launchOpts = process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH, args: (process.env.CHROME_ARGS ?? '').split(' ').filter(Boolean), headless: 'shell' }
  : { headless: true };
const browser = await puppeteer.launch(launchOpts);
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 1200, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'icons.html')).href, { waitUntil: 'load' });
const ids = JSON.parse(readFileSync(path.join(here, 'icons.json'), 'utf8'));
mkdirSync(path.join(root, 'resources/presence'), { recursive: true });
for (const id of ids) {
  const out = id === 'app-1024' ? path.join(root, 'resources/icon.png') : path.join(root, 'resources/presence', `${id}.png`);
  const el = await page.$(`[id="${id}"] svg`);
  await el.screenshot({ path: out, omitBackground: true });
}
await browser.close();
console.log(`rendered ${ids.length} icons`);
