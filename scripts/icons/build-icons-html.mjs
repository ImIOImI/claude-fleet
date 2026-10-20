// Generates scripts/icons/icons.html: every app / tray / taskbar-overlay image
// as an SVG element with a stable id. scripts/icons/render-icons.mjs exports
// each to a transparent PNG. Design: the "Teardrop" outline starship chosen in
// docs/superpowers/specs/2026-10-20-inbox-automations-design.md (#407).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TILE = 'oklch(14% 0.006 80)', EDGE = 'oklch(27% 0.008 80)', HULL = 'url(#sg-hull)', INK1 = 'oklch(78% 0.008 80)', INK3 = 'oklch(45% 0.008 80)', CUT = 'oklch(14% 0.006 80)', GREEN = 'oklch(70% 0.16 145)';
const glow = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r * 2.6}" fill="url(#sg-glow)"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${GREEN}"/>`;
const INK = 'oklch(94% 0.005 80)';
// Ship drawn pointing right (+x) around (32,32); rotated into a climb.
const strip = (x, y, w) => `<rect x="${x}" y="${y - 2.2}" width="${w}" height="4.4" rx="2.2" fill="url(#sg-glow-h)"/><rect x="${x}" y="${y - 0.8}" width="${w}" height="1.6" rx="0.8" fill="${GREEN}"/>`;
const SAUCER_PATH = 'M59 32C59 24.5 47 20.5 36 21.5C28 22.2 23 26 23 32C23 38 28 41.8 36 42.5C47 43.5 59 39.5 59 32Z';
const intrepid = (small) => small ? `<g transform="rotate(-34 32 32)">
    <path d="M4.5 18.5H22M4.5 45.5H22" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
    <path d="M7 18.5H19.5M7 45.5H19.5" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <path d="${SAUCER_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="3.4"/>
    <circle cx="44" cy="32" r="2.6" fill="${INK}"/>
  </g>` : `<g transform="rotate(-34 32 32)">
    <path d="M19 29.5L13.5 19.5M19 34.5L13.5 44.5" stroke="${INK1}" stroke-width="1.6" stroke-linecap="round"/>
    <rect x="2.5" y="16" width="23" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="1.5"/>
    <rect x="2.5" y="43.4" width="23" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="1.5"/>
    ${strip(6, 18.3, 15)}${strip(6, 45.7, 15)}
    <path d="M24.5 28L13 30.2Q10 32 13 33.8L24.5 36" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M13.5 32H22" stroke="${INK1}" stroke-width="1" stroke-dasharray="1.2 1.6" opacity=".8"/>
    <path d="${SAUCER_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="1.6"/>
    <path d="M56 32C56 26.5 46.5 23.7 37 24.4C30.5 24.9 26.4 27.8 26.4 32C26.4 36.2 30.5 39.1 37 39.6C46.5 40.3 56 37.5 56 32Z" fill="none" stroke="${INK1}" stroke-width=".9" stroke-dasharray="1.1 1.9" opacity=".85"/>
    <ellipse cx="43" cy="32" rx="8.5" ry="4.6" fill="none" stroke="${INK1}" stroke-width=".9" opacity=".7"/>
    <ellipse cx="45" cy="32" rx="3" ry="1.8" fill="none" stroke="${INK}" stroke-width="1.1"/>
    <path d="M27 32H33.5" stroke="${INK1}" stroke-width=".9" opacity=".6"/>
    <circle cx="25.4" cy="32" r="1.6" fill="${GREEN}"/>
  </g>`;

const svgDefs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <radialGradient id="sg-glow"><stop offset="0" stop-color="${GREEN}" stop-opacity=".75"/><stop offset=".45" stop-color="${GREEN}" stop-opacity=".22"/><stop offset="1" stop-color="${GREEN}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sg-glow-h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${GREEN}" stop-opacity="0"/><stop offset=".5" stop-color="${GREEN}" stop-opacity=".35"/><stop offset="1" stop-color="${GREEN}" stop-opacity="0"/></linearGradient>
  <linearGradient id="sg-hull" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="oklch(98% 0.004 80)"/><stop offset="1" stop-color="oklch(84% 0.008 80)"/></linearGradient>
</defs></svg>`;
const RED = 'oklch(66% 0.18 28)', VIOLET = 'oklch(68% 0.17 300)', RING = 'oklch(14% 0.006 80)';

/** The app tile: full detail above 24px, the reduced saucer + nacelles at or below. */
function tile(size, dot = null) {
  const small = size <= 24;
  const scale = small ? 0.84 : 0.76;
  const d = dot ? `<circle cx="51" cy="51" r="${small ? 12 : 10}" fill="${dot === 'urgent' ? RED : VIOLET}" stroke="${RING}" stroke-width="${small ? 4 : 3}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
    <rect x=".5" y=".5" width="63" height="63" rx="14" fill="${TILE}" stroke="${EDGE}"/>
    <g transform="translate(32 32) scale(${scale}) translate(-32 -31)">${intrepid(small)}</g>${d}</svg>`;
}

/** Windows taskbar overlay (16px): a dot, or a count badge. */
function overlay(kind, label) {
  const fill = kind === 'urgent' ? RED : VIOLET;
  if (!label) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="${RING}" stroke-width="1.5"/></svg>`;
  const fs = label.length > 1 ? 8 : 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="7.25" fill="${fill}" stroke="${RING}" stroke-width="1.5"/>
    <text x="8" y="8.6" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${label}</text></svg>`;
}

const items = [
  ['app-1024', tile(1024)],
  ['window-256', tile(256)],
  ...['none', 'urgent', 'wait'].flatMap((k) => [
    [`tray-${k}-16`, tile(16, k === 'none' ? null : k)],
    [`tray-${k}-32`, tile(32, k === 'none' ? null : k)]
  ]),
  ...['urgent', 'wait'].flatMap((k) => [
    [`overlay-${k}`, overlay(k, '')],
    ...['2', '3', '4', '5', '6', '7', '8', '9', '9+'].map((n) => [`overlay-${k}-${n === '9+' ? '9plus' : n}`, overlay(k, n)])
  ])
];

const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:transparent}.i{display:inline-block;margin:4px}svg{display:block}</style>
${svgDefs.replace('style="position:absolute"', 'style="position:absolute"')}
${items.map(([id, svg]) => `<div class="i" id="${id}">${svg}</div>`).join('\n')}`;
writeFileSync(path.join(here, 'icons.html'), html);
writeFileSync(path.join(here, 'icons.json'), JSON.stringify(items.map(([id]) => id)));
console.log(`wrote ${items.length} icons to scripts/icons/icons.html`);
