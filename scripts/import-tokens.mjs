#!/usr/bin/env node
// Merge a Figma export (the return value of scripts/figma-export-tokens.js,
// saved as JSON) into docs/design/tokens.json.
//
// The export is the source of truth for structure and values: every token it
// carries lands, every token it lacks is dropped. What the export cannot
// carry is kept from the existing file — a `$description` where Figma has
// none, the top-level `$description` and `$extensions`, and a `com.light.css`
// name where the export did not record one. Then `npm run tokens`.
//
//   node scripts/import-tokens.mjs export.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, 'docs', 'design', 'tokens.json');
const [, , exportPath] = process.argv;
if (!exportPath) {
  console.error('usage: node scripts/import-tokens.mjs <export.json>');
  process.exit(2);
}
const incoming = JSON.parse(readFileSync(exportPath, 'utf8'));
const existing = JSON.parse(readFileSync(TOKENS, 'utf8'));

const isToken = (v) => v && typeof v === 'object' && '$value' in v;
const stats = { kept: 0, added: 0, removed: 0, changed: 0, descriptions: 0 };

function merge(into, from, path = []) {
  const out = {};
  for (const [k, v] of Object.entries(from)) {
    const prev = into?.[k];
    if (isToken(v)) {
      const t = { ...v };
      // a description that only repeats the value is noise; a transport may
      // have entity-escaped the text
      if (typeof t.$description === 'string') {
        t.$description = t.$description.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        if (String(t.$value).toLowerCase() === t.$description.toLowerCase().replace(/ff$/, '') || String(t.$value).toLowerCase() === t.$description.toLowerCase()) delete t.$description;
      }
      if (prev && isToken(prev)) {
        if (!t.$description && prev.$description) { t.$description = prev.$description; stats.descriptions++; }
        const prevCss = prev.$extensions?.['com.light.css'];
        if (prevCss && !t.$extensions?.['com.light.css']) t.$extensions = { ...(t.$extensions ?? {}), 'com.light.css': prevCss };
        if (JSON.stringify(prev.$value) !== JSON.stringify(t.$value)) stats.changed++;
        else stats.kept++;
      } else stats.added++;
      out[k] = t;
    } else if (v && typeof v === 'object') {
      out[k] = merge(prev && typeof prev === 'object' ? prev : {}, v, [...path, k]);
    } else out[k] = v;
  }
  const count = (g) => Object.values(g).reduce((n, v) => n + (isToken(v) ? 1 : v && typeof v === 'object' ? count(v) : 0), 0);
  for (const [k, v] of Object.entries(into ?? {})) {
    if (k.startsWith('$') || k in from) continue;
    stats.removed += isToken(v) ? 1 : count(v);
    console.log(`  dropped ${[...path, k].join('/')} — not in the export`);
  }
  return out;
}

const result = {};
for (const [k, v] of Object.entries(existing)) if (k.startsWith('$')) result[k] = v; // top-level description and extensions stay
for (const group of ['primitive', 'semantic', 'type', 'space', 'radius', 'size', 'elevation', 'motion']) {
  if (!incoming[group]) { console.error(`export has no ${group} group — refusing`); process.exit(1); }
  result[group] = merge(existing[group], incoming[group]);
}
if (result.$extensions?.['com.light.figma']) result.$extensions['com.light.figma'].exportedAt = new Date().toISOString().slice(0, 10);
writeFileSync(TOKENS, JSON.stringify(result, null, 2) + '\n');
console.log(`tokens.json: ${stats.kept} unchanged, ${stats.changed} changed, ${stats.added} added, ${stats.removed} dropped; ${stats.descriptions} descriptions kept from the file\nnow: npm run tokens`);
