#!/usr/bin/env node
// The token drift check: the design system in Figma and the CSS must agree.
//
//   1. ui/src/tokens.css and ui/src/tokens.ts are exactly what build-tokens.mjs
//      generates from docs/design/tokens.json (else: `npm run tokens`).
//   2. No stylesheet under ui/src carries a value Figma owns as a literal — a
//      colour, a radius, a font size, tracking, leading, a weight, a duration,
//      or a px space/size in a property that means one — so a change in Figma
//      reaches the screen through the variable, and a literal typed into the
//      CSS is caught here rather than drifting. A line that is deliberately not
//      a token says so: `/* not a token: <why> */`.
//   3. Every `var(--x)` the UI reads is defined somewhere: tokens.css, theme.css
//      or an inline style — `var(--amber, #f0a63e)` on an undefined --amber is
//      exactly the kind of quiet fallback this exists to stop.
//   4. Inline styles in .tsx files use no literal colours, and index.html's
//      pre-CSS ground is a token value.
//   5. The design decisions a token alone cannot hold ("The desk stays lit",
//      docs/design/the-desk-stays-lit.md): the accent is the cursor and nothing
//      else; a pad face carries only the three opacities that are its state;
//      the Pads defaults are one named constant read from the tokens; a canvas
//      drawing chrome paints from the tokens; and the long-press and the ring
//      that draws it are the same number. Each of these is one edit from being
//      undone in a way that would not look like a mistake.
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

// --- 2. literals in every stylesheet the UI loads
const THEME = join(ROOT, 'ui', 'src', 'theme.css');
const theme = readFileSync(THEME, 'utf8');
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const SPACE_PROPS = /^(padding|padding-(top|right|bottom|left)|margin|margin-(top|right|bottom|left)|gap|row-gap|column-gap|top|right|bottom|left|inset)$/;
const SIZE_PROPS = /^(width|height|min-width|min-height|max-width|max-height|flex-basis|flex|grid-template-rows|grid-template-columns)$/;
const DURATION_PROPS = /^(transition|transition-duration|animation|animation-duration)$/;
/** Every stylesheet under ui/src except the generated one. A per-component
 *  sheet must obey the same rules as theme.css, or the next file added is a
 *  place literals can live. */
const STYLESHEETS = [];
{
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.css') && f !== 'tokens.css') STYLESHEETS.push(p);
    }
  };
  walk(join(ROOT, 'ui', 'src'));
}
for (const SHEET of STYLESHEETS) {
  const sheet = readFileSync(SHEET, 'utf8');
  const lines = sheet.split('\n');
  // declarations, with the line they start on; comments are blanked first so a
  // `/* 3px */` cannot masquerade as a value — except the exemption marker
  let exempt = new Set();
  lines.forEach((l, i) => { if (/not a token:/.test(l)) exempt.add(i + 1); });
  const blanked = sheet.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const declRe = /([a-z-]+)\s*:\s*([^;{}]+);/g;
  for (const m of blanked.matchAll(declRe)) {
    const prop = m[1];
    const value = m[2].trim();
    const line = blanked.slice(0, m.index).split('\n').length;
    if (exempt.has(line)) continue;
    if (prop.startsWith('--')) continue;
    const where = (what, fix) => hit(SHEET, line, `${prop}: ${value} — ${what}`, fix);
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

// --- 5. the design's rules that a token on its own cannot hold.
//
// "The desk stays lit" (docs/design/the-desk-stays-lit.md) rests on a handful
// of decisions that are one edit from being undone and would not look like a
// mistake: an accent on a new toggle, an opacity typed onto a pad face, a
// default flipped back in the store. Each is enforced here so it has to be
// argued rather than drifted.

// (a) the accent is the cursor, and nothing else.
//
// Three colours mean three things (design 3.6): tungsten is what is playing,
// cyan is where the operator's attention is, amber and red are trouble. The
// check is on the RESOLVED colour, not the name — `--accent-soft`, a raw
// `--alpha-cyan-16` and any later alias all land in the same net.
{
  const cyanValues = new Set();
  for (const [name, raw] of defined) {
    if (/^--(cyan|alpha-cyan)-/.test(name)) cyanValues.add(norm(resolveVar(raw)));
  }
  const accentVars = new Set();
  for (const [name, raw] of defined) if (cyanValues.has(norm(resolveVar(raw)))) accentVars.add(name);
  // Each entry is a selector the design names as the cursor, with its reason.
  const CURSOR = [
    [/:focus(-visible)?\b/, 'keyboard focus'],
    [/\binput[.\w-]*:focus\b/, 'the text cursor'],
    [/\.bpmedit\b/, 'the tempo being typed'],
    [/\.selected\b/, 'the selected pad'],
    [/\.selcol\b/, 'the column a head or a digit key selected on a page that does not fire'],
    [/\.rowsel\b/, 'the selected row'],
    [/\.learn-armed\b|\.learn\b/, 'a control armed for MIDI learn, and the wash behind it'],
    [/\.droptarget\b/, 'where a dragged look would land'],
    [/\.armed\b/, 'an armed library tile'],
    [/\.editing\b/, 'the song being edited rather than played'],
    [/\.stripe\.live\b/, 'the editor stripe that says edits reach the rig'],
    // Two the design does not list, kept deliberately: both mark where the
    // operator's attention has been put, which is what the cursor colour is for.
    [/\.helpcard\b/, 'the help card, which marks the control just tapped'],
    [/\.setupstep\.next\b/, 'the step the setup guide is waiting on'],
  ];
  for (const SHEET of STYLESHEETS) {
    const sheet = readFileSync(SHEET, 'utf8');
    const blanked = sheet.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of blanked.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (sel.startsWith('@') || sel.startsWith(':root')) continue;
      const line = blanked.slice(0, m.index).split('\n').length;
      if (CURSOR.some(([re]) => re.test(sel))) continue;
      for (const v of accentVars) {
        if (!m[2].includes(`var(${v})`)) continue;
        hit(SHEET, line, `${sel} paints with ${v}, which resolves to the accent`,
          'the accent is the programmer’s cursor only (design 3.6). What is playing is var(--color-live); a pressed key is a lamp; trouble is amber or red. If this really is a cursor, add its selector to CURSOR in this script with its reason.');
      }
    }
  }
}

// (b) a pad face carries no opacity but the three the design names.
// Brightness IS the pad's state — rest, hover, playing — so a fourth value
// typed in is a fourth state nobody named.
{
  const FACE = /\.cell\b[^{,]*\s\.(swatch|face)\b/;
  const allowed = new Set([...defined].filter(([n]) => n.startsWith('--opacity-face-')).map(([n]) => `var(${n})`));
  for (const SHEET of STYLESHEETS) {
    const sheet = readFileSync(SHEET, 'utf8');
    const blanked = sheet.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of blanked.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!FACE.test(sel)) continue;
      const line = blanked.slice(0, m.index).split('\n').length;
      for (const d of m[2].split(';')) {
        const o = /^\s*opacity\s*:\s*(.+)$/.exec(d);
        if (o && !allowed.has(o[1].trim())) {
          hit(SHEET, line, `${sel} sets opacity: ${o[1].trim()} on a pad face`,
            'a pad face is rest, hover or playing — use var(--opacity-face-rest / -hover / -playing)');
        }
      }
    }
  }
}

// (c) the Pads defaults are one named constant, read from the tokens.
// The whole grid-first layout is a default; typed back into the store's
// initial state it would be a one-character revert with no test to catch it.
{
  const STORE = join(ROOT, 'ui', 'src', 'store.ts');
  const store = readFileSync(STORE, 'utf8');
  const lineOf = (i) => store.slice(0, i).split('\n').length;
  // the store's own initial state, not the constant it reads
  const from = store.indexOf('create<Store>');
  const initial = from < 0 ? '' : store.slice(from);
  for (const key of ['libraryHidden', 'editorHidden', 'previewPane']) {
    const m = new RegExp(`^\\s{2}${key}:\\s*(.+),$`, 'm').exec(initial);
    if (!m) { hit(STORE, 1, `the store has no initial ${key}`, 'the Pads defaults live in PADS_OPENS'); continue; }
    if (!m[1].includes('PADS_OPENS')) {
      hit(STORE, lineOf(from + m.index), `${key} opens as ${m[1]} rather than from PADS_OPENS`,
        'Pads opens grid-first (design #2, A15) — the default belongs in PADS_OPENS so it is one place, and this check holds it');
    }
  }
  const ratioLine = /bandRatio:\s*(.+),/.exec(store);
  if (ratioLine && !ratioLine[1].includes('ratio[')) {
    hit(STORE, lineOf(ratioLine.index), `the band's share of the window is ${ratioLine[1]}`, "use ratio['band-pads'] from tokens.ts");
  }
}

// (d) a canvas that draws chrome paints from the tokens too.
// The two stage renderers keep a palette of their own — a beam, a lens, a body
// and a band figure are the scene, not the design system, and section 4 exempts
// them for that reason. Everything else that reaches for a 2D context is
// drawing chrome: the output meter's ground, its spans, its labels and the
// channel sitting at zero all have to move when Figma moves (design R7).
const SCENE_RENDERERS = new Set(['Previz2D.tsx', 'Previz3D.tsx']);
for (const p of sources.filter((f) => f.endsWith('.tsx') && !SCENE_RENDERERS.has(f.split('/').pop()))) {
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(/\b(fillStyle|strokeStyle)\s*=\s*(['"`])([^'"`]*)\2/g)) {
    if (m[3].includes('${')) continue; // computed, not chosen
    hit(p, text.slice(0, m.index).split('\n').length, `${m[1]} is the literal ${m[2]}${m[3]}${m[2]}`,
      "read it from color[…] in tokens.ts, or mark the line `/* not a token: why */`");
  }
}

// (e) the long-press and the ring that draws it are one number.
// touch.ts's LONG_PRESS_MS and --motion-hold have to agree or the ring finishes
// at a different moment from the gesture; they agree by being the same token.
{
  const TOUCH = join(ROOT, 'ui', 'src', 'touch.ts');
  const text = readFileSync(TOUCH, 'utf8');
  text.split('\n').forEach((l, i) => {
    if (/not a token:/.test(l) || l.trim().startsWith('*') || l.trim().startsWith('//')) return;
    for (const m of l.matchAll(/(?<![\w.])(\d{2,})(?![\w.])/g)) {
      if (Number(m[1]) < 20) continue; // a pixel slop, not a duration
      hit(TOUCH, i + 1, `the literal ${m[1]}`, 'a duration here must read motion.hold from tokens.ts, so the ring and the timer are the same number');
    }
  });
}

console.log(`\ntokens: ${hits} drift hit${hits === 1 ? '' : 's'}`);
process.exit(hits ? 1 : 0);
