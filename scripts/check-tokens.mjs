#!/usr/bin/env node
// The token drift check: the design system in Figma and the CSS must agree.
//
//   1. ui/src/tokens.css and ui/src/tokens.ts are exactly what build-tokens.mjs
//      generates from docs/design/tokens.json (else: `npm run tokens`).
//   2. ui/src/theme.css carries no value Figma owns as a literal — a colour, a
//      radius, a font size, tracking, leading, a weight, a duration, or a px
//      space/size in a property that means one — so a change in Figma reaches
//      the screen through the variable, and a literal typed into the CSS is
//      caught here rather than drifting. A line that is deliberately not a
//      token says so: `/* not a token: <why> */`.
//   3. Every `var(--x)` the UI reads is defined somewhere: tokens.css, theme.css
//      or an inline style — `var(--amber, #f0a63e)` on an undefined --amber is
//      exactly the kind of quiet fallback this exists to stop.
//   4. Inline styles in .tsx files use no literal colours, and index.html's
//      pre-CSS ground is a token value.
//
//   node scripts/check-tokens.mjs    # exit 1 on any hit
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { generate, OUT_CSS, OUT_TS } from './build-tokens.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const rel = (p) => relative(ROOT, p);
let hits = 0;
const hit = (file, line, what, fix = '') => {
  hits++;
  console.log(`${rel(file)}:${line} ${what}${fix ? `\n    ↳ ${fix}` : ''}`);
};

// --- 1. generated files are current
const { css: wantCss, ts: wantTs } = generate();
for (const [path, want] of [[OUT_CSS, wantCss], [OUT_TS, wantTs]]) {
  let have = null;
  try { have = readFileSync(path, 'utf8'); } catch { /* missing */ }
  if (have !== want) hit(path, 1, 'is not what tokens.json generates', 'run `npm run tokens` and commit the result');
}

// --- the token index, from the generated CSS itself
const defined = new Map(); // --name → value
for (const m of wantCss.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) if (!defined.has(m[1])) defined.set(m[1], m[2].trim());
const resolveVar = (v, depth = 0) => {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(v.trim());
  if (!m || depth > 8) return v;
  return resolveVar(defined.get(m[1]) ?? v, depth + 1);
};
const norm = (c) => {
  // every colour as 8-digit lowercase hex, so #fff, #ffffff and rgba(255,255,255,1) meet
  c = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(c);
  if (m) c = '#' + [...m[1]].map((x) => x + x).join('');
  m = /^#([0-9a-f]{6})$/.exec(c);
  if (m) return `#${m[1]}ff`;
  m = /^#([0-9a-f]{8})$/.exec(c);
  if (m) return c;
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c);
  if (m) {
    const a = m[4] === undefined ? 255 : Math.round(Number(m[4]) * 255);
    return '#' + [m[1], m[2], m[3], a].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  return null;
};
const colourOwner = new Map(); // normalised colour → var name (semantic first, then primitive)
for (const [name, raw] of defined) {
  const v = resolveVar(raw);
  const n = norm(v);
  if (n && !colourOwner.has(n)) colourOwner.set(n, name);
}
for (const [name, raw] of [...defined].reverse()) {
  // prefer a semantic name (--bg, --color-…) over the primitive it aliases
  const n = norm(resolveVar(raw));
  if (n && !name.startsWith('--grey-') && !/^--(alpha|cyan|green|amber|orange|red|rose|swatch|scene)-/.test(name)) colourOwner.set(n, name);
}
const byValue = (prefix) => {
  const m = new Map();
  for (const [name, v] of defined) if (name.startsWith(prefix)) m.set(v, name);
  return m;
};
const spaceByPx = byValue('--space-');
const radiusByPx = byValue('--radius-');
const sizeByPx = byValue('--size-');
for (const [name, v] of defined) if (name === '--strip' || name === '--padname-h') sizeByPx.set(v, name);
const fontSizeByPx = byValue('--font-size-');
const motionByMs = byValue('--motion-');

// --- 2. theme.css literals
const THEME = join(ROOT, 'ui', 'src', 'theme.css');
const theme = readFileSync(THEME, 'utf8');
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const SPACE_PROPS = /^(padding|padding-(top|right|bottom|left)|margin|margin-(top|right|bottom|left)|gap|row-gap|column-gap|top|right|bottom|left|inset)$/;
const SIZE_PROPS = /^(width|height|min-width|min-height|max-width|max-height|flex-basis|flex|grid-template-rows|grid-template-columns)$/;
const DURATION_PROPS = /^(transition|transition-duration|animation|animation-duration)$/;
{
  const lines = theme.split('\n');
  // declarations, with the line they start on; comments are blanked first so a
  // `/* 3px */` cannot masquerade as a value — except the exemption marker
  let exempt = new Set();
  lines.forEach((l, i) => { if (/not a token:/.test(l)) exempt.add(i + 1); });
  const blanked = theme.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const declRe = /([a-z-]+)\s*:\s*([^;{}]+);/g;
  for (const m of blanked.matchAll(declRe)) {
    const prop = m[1];
    const value = m[2].trim();
    const line = blanked.slice(0, m.index).split('\n').length;
    if (exempt.has(line)) continue;
    if (prop.startsWith('--')) continue;
    const where = (what, fix) => hit(THEME, line, `${prop}: ${value} — ${what}`, fix);
    // colours, anywhere
    for (const c of value.match(COLOR_RE) ?? []) {
      const n = norm(c);
      const owner = n && colourOwner.get(n);
      where(`literal colour ${c}`, owner ? `use var(${owner})` : 'no token has this colour — add it in Figma, or mark the line `/* not a token: why */`');
    }
    const pxs = [...value.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px\b/g)].map((x) => x[1] + 'px');
    if (prop === 'border-radius') {
      for (const p of pxs) where(`literal radius ${p}`, radiusByPx.has(p) ? `use var(${radiusByPx.get(p)})` : 'no radius token has this value');
    } else if (prop === 'font-size') {
      for (const p of pxs) where(`literal font size ${p}`, fontSizeByPx.has(p) ? `use the text style’s size, or var(${fontSizeByPx.get(p)})` : 'no type size token has this value');
    } else if (prop === 'letter-spacing') {
      if (/^-?\d*\.?\d+(em|px)$/.test(value) && Number.parseFloat(value) !== 0) where('literal tracking', 'use the text style’s --text-<style>-tracking');
    } else if (prop === 'line-height') {
      if (/^\d*\.?\d+(px)?$/.test(value)) where('literal leading', 'use the text style’s --text-<style>-leading or --leading-*');
    } else if (prop === 'font-weight') {
      if (/^\d+$/.test(value)) where('literal weight', 'use var(--weight-*)');
    } else if (prop === 'font-family') {
      if (!/^(var\(|inherit)/.test(value)) where('literal family', 'use var(--font) or var(--mono)');
    } else if (SPACE_PROPS.test(prop)) {
      for (const p of pxs) if (spaceByPx.has(p)) where(`literal space ${p}`, `use var(${spaceByPx.get(p)})`);
        else where(`space ${p} is not on the scale`, 'add it to the Space collection in Figma, or mark the line `/* not a token: why */`');
    } else if (SIZE_PROPS.test(prop)) {
      for (const p of pxs) where(`literal size ${p}`, sizeByPx.has(p) ? `use var(${sizeByPx.get(p)})` : 'no size token has this value — add it in Figma, or mark the line');
    } else if (DURATION_PROPS.test(prop)) {
      for (const t of value.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)) {
        const ms = t[2] === 's' ? String(Math.round(Number(t[1]) * 1000)) + 'ms' : t[1] + 'ms';
        where(`literal duration ${t[0]}`, motionByMs.has(ms) ? `use var(${motionByMs.get(ms)})` : 'no motion token has this value');
      }
    }
  }
}

// --- 3. every var() read is defined somewhere
const UI = join(ROOT, 'ui', 'src');
function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(tsx?|css)$/.test(f) && !f.endsWith('.d.ts')) yield p;
  }
}
const allDefined = new Set(defined.keys());
for (const m of theme.matchAll(/(--[a-z0-9-]+)\s*:/g)) allDefined.add(m[1]);
const sources = [...files(UI)].filter((p) => !p.endsWith('tokens.css') && !p.endsWith('tokens.ts'));
for (const p of sources) {
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(/\[?['"](--[a-z0-9-]+)['"]\s*(?:as string\])?\s*[:\]]/g)) allDefined.add(m[1]);
}
for (const p of sources) {
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!allDefined.has(m[1])) hit(p, text.slice(0, m.index).split('\n').length, `reads ${m[1]}, which nothing defines`);
  }
}

// --- 4. inline styles carry no literal colour; index.html's ground is a token.
// The canvas and WebGL renderers paint with a palette of their own (beams,
// glass, band figures) — only the grounds they share with the chrome are
// tokens (scene/*), read from tokens.ts. A colour built from a template is
// computed, not chosen.
const RENDERERS = new Set(['Previz2D.tsx', 'Previz3D.tsx', 'OutputView.tsx']);
for (const p of sources.filter((f) => f.endsWith('.tsx') && !RENDERERS.has(f.split('/').pop()))) {
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/not a token:/.test(l)) return;
    for (const c of l.match(COLOR_RE) ?? []) {
      if (c.includes('${')) continue;
      const n = norm(c);
      const owner = n && colourOwner.get(n);
      hit(p, i + 1, `literal colour ${c} in a component`, owner ? `use var(${owner}), or color[…] from tokens.ts` : 'no token has this colour — add it in Figma, or mark the line `/* not a token: why */`');
    }
  });
}
{
  const html = join(ROOT, 'ui', 'index.html');
  const text = readFileSync(html, 'utf8');
  for (const c of text.match(COLOR_RE) ?? []) {
    const n = norm(c);
    if (!n || !colourOwner.has(n)) hit(html, text.slice(0, text.indexOf(c)).split('\n').length, `${c} is not a token value`, 'index.html paints before CSS loads, so it must repeat a token’s value exactly');
  }
}

console.log(`\ntokens: ${hits} drift hit${hits === 1 ? '' : 's'}`);
process.exit(hits ? 1 : 0);
