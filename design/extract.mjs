#!/usr/bin/env node
// Unpacks a v0-style "self-contained" design HTML into individual JSX
// artboard files under design/components/, plus a README index.
//
// Usage: node design/extract.mjs [path-to-export.html]
// Defaults to design/claude-fleet-hi-fi.html.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DESIGN = __dirname;
const COMPONENTS_DIR = resolve(REPO_DESIGN, 'components');

const htmlPath = resolve(REPO_DESIGN, process.argv[2] ?? 'claude-fleet-hi-fi.html');
if (!existsSync(htmlPath)) {
  console.error(`No file at ${htmlPath}`);
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');
const manifestMatch = html.match(
  /<script type="__bundler\/manifest">\s*([\s\S]*?)\s*<\/script>/
);
if (!manifestMatch) {
  console.error('Could not find <script type="__bundler/manifest"> in the HTML.');
  process.exit(1);
}
const bundle = JSON.parse(manifestMatch[1]);

// The bundler template also carries the canonical design-token stylesheet —
// pull it into design/tokens.css so we can reference it without unpacking
// the whole HTML.
const templateMatch = html.match(
  /<script type="__bundler\/template">\s*"([\s\S]*?)"\s*<\/script>/
);
let tokensCss = null;
if (templateMatch) {
  const tpl = JSON.parse(`"${templateMatch[1]}"`);
  // The tokens stylesheet starts with the comment "Hi-fi design tokens for claude-fleet."
  const tokensRe = /<style>(\/\*\s*Hi-fi design tokens[\s\S]*?)<\/style>/;
  const m = tpl.match(tokensRe);
  if (m) tokensCss = m[1];
}

// Clean components/ before re-extracting so renamed/removed entries don't linger.
rmSync(COMPONENTS_DIR, { recursive: true, force: true });
mkdirSync(COMPONENTS_DIR, { recursive: true });

const VENDOR_PATTERNS = [
  /^\/\*\*\s*\n\s*\*\s*@license\s+React\b/,
  /react-dom\.development\.js/i,
  /scheduler\.development\.js/i,
  /@babel\/standalone/i,
  /eval\?babel/i,
  /^!function\(/ // unminified UMD bundle preamble
];

function isVendor(src) {
  const head = src.slice(0, 600);
  return VENDOR_PATTERNS.some((re) => re.test(head));
}

function slugFromHeader(src, fallback) {
  // The artboards follow a "// Title — description" pattern in their first
  // comment line. Take just the title (before em-dash, colon, period, or
  // comma), drop any .jsx/.js suffix, and slugify.
  const lines = src.split('\n').slice(0, 12);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('//')) continue;
    const text = line.replace(/^\/\/\s*/, '').replace(/\.+$/, '');
    if (!text) continue;
    const title = text
      .split(/[—:.,]/)[0]
      .trim()
      .replace(/\.(jsx?|tsx?)$/i, '');
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug.length === 0) continue;
    return slug.slice(0, 40);
  }
  return fallback;
}

function firstCommentBlock(src) {
  const lines = src.split('\n');
  const collected = [];
  for (const raw of lines) {
    if (raw.startsWith('//')) {
      collected.push(raw.replace(/^\/\/\s?/, ''));
    } else if (collected.length === 0 && raw.trim() === '') {
      continue;
    } else {
      break;
    }
  }
  return collected.join('\n').trim();
}

const entries = [];
const used = new Set();

const JS_MIMES = new Set(['text/javascript', 'application/javascript', 'text/jsx']);

for (const [id, entry] of Object.entries(bundle)) {
  if (!JS_MIMES.has(entry.mime)) continue;

  const buf = Buffer.from(entry.data, 'base64');
  const text = entry.compressed ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');

  if (isVendor(text)) continue;

  // Skip pure metadata / empty entries
  if (text.length < 80) continue;

  const baseSlug = slugFromHeader(text, id.slice(0, 8));
  let slug = baseSlug;
  let n = 2;
  while (used.has(slug)) slug = `${baseSlug}-${n++}`;
  used.add(slug);

  const file = `${slug}.jsx`;
  writeFileSync(resolve(COMPONENTS_DIR, file), text);
  entries.push({ id, file, header: firstCommentBlock(text), bytes: text.length });
}

entries.sort((a, b) => a.file.localeCompare(b.file));

const readme = `# Design folder

The hi-fi visual reference for claude-fleet, exported from v0-style design
tooling and unpacked into readable artboards.

## Files

- \`claude-fleet-hi-fi.html\` — the original packed export. Open it in a
  browser to see the rendered mockup; it self-decompresses on load.
- \`tokens.css\` — the canonical design-token stylesheet pulled out of the
  export's runtime template. Light + dark theme variables (\`--bg\`,
  \`--ink\`, per-container accents \`--c1\`/\`--c2\`/\`--c3\`, semantic
  \`--ok\`/\`--warn\`/\`--danger\`, etc.). Use these names when adding to
  \`src/renderer/src/styles.css\` so the implementation stays aligned
  with the design.
- \`components/\` — the artboards as readable React/JSX (one file each).
- \`extract.mjs\` — the unpacker that produced \`components/\` and
  \`tokens.css\`. Re-run it after replacing the HTML to keep everything
  in sync:
  \`\`\`
  node design/extract.mjs
  \`\`\`
  Vendor bundles (React, ReactDOM, Babel), woff2 fonts, and tiny stub
  entries are filtered out.

## Artboards (${entries.length})

Each file under \`components/\` is a single React/JSX artboard from the
export. The first comment block in each file is the design author's note
on what the artboard shows.

| File | Header |
|---|---|
${entries
  .map((e) => {
    const headline = e.header.split('\n')[0] || '(no header)';
    return `| [\`${e.file}\`](components/${e.file}) | ${headline} |`;
  })
  .join('\n')}

## How to use this in code

These artboards aren't built or imported — they're a static visual
reference. When implementing a UI piece, find the matching artboard
and copy structure / class names / inline styles from it. The canonical
implementation lives under \`src/renderer/\`; the artboards are the
*design intent*, not authoritative code.

If a token from \`tokens.css\` isn't yet in \`src/renderer/src/styles.css\`,
lift it in when you reach for it — keep names consistent so a future
search across both folders matches.
`;

writeFileSync(resolve(REPO_DESIGN, 'README.md'), readme);

if (tokensCss) {
  writeFileSync(resolve(REPO_DESIGN, 'tokens.css'), tokensCss + '\n');
  console.log('Wrote design/tokens.css');
}

console.log(`Extracted ${entries.length} artboards to design/components/`);
console.log(`Wrote design/README.md`);
