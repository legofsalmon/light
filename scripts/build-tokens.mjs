#!/usr/bin/env node
// Generate ui/src/tokens.css and ui/src/tokens.ts from docs/design/tokens.json.
//
// Figma (the LIGHT Design System file) is the source of truth; tokens.json is
// its export, and these two files are what the code consumes: every custom
// property theme.css uses, and the numbers App.tsx lays the grid out with.
// Nothing in here is written by hand — `npm run tokens` after re-exporting,
// and `npm run typecheck` fails (scripts/check-tokens.mjs) when either file
// is stale or theme.css carries a value Figma does not know.
//
//   node scripts/build-tokens.mjs          # write both files
//   import { generate } from './build-tokens.mjs'   # the checker's view
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOKENS_JSON = join(ROOT, 'docs', 'design', 'tokens.json');
export const OUT_CSS = join(ROOT, 'ui', 'src', 'tokens.css');
export const OUT_TS = join(ROOT, 'ui', 'src', 'tokens.ts');

/** Flatten a group into [path[], token] pairs, skipping $-keys. */
function* walk(group, path = []) {
  for (const [k, v] of Object.entries(group)) {
    if (k.startsWith('$')) continue;
    if (v && typeof v === 'object' && '$value' in v) yield [[...path, k], v];
    else if (v && typeof v === 'object') yield* walk(v, [...path, k]);
  }
}

const kebab = (s) => String(s).replace(/_/g, '-').replace(/\//g, '-');

/** The CSS custom property a token becomes: its `com.light.css` name when the
 *  code already had one (--accent, --line2…), else `--<prefix>-<path>`. */
function cssName(group, path, token) {
  const own = token.$extensions?.['com.light.css'];
  if (own) return own;
  const prefix = {
    primitive: '',
    semantic: 'color',
    space: 'space',
    radius: 'radius',
    size: 'size',
    motion: 'motion',
    elevation: 'elevation',
  }[group];
  if (group === 'type') {
    const [head, ...rest] = path;
    if (head === 'family') return `--font-${kebab(rest.join('-'))}`;
    if (head === 'weight') return `--weight-${kebab(rest.join('-'))}`;
    if (head === 'line-height') return `--leading-${kebab(rest.join('-'))}`;
    if (head === 'size') return `--font-size-${kebab(rest.join('-'))}`;
    if (head === 'style') return `--text-${kebab(rest.join('-'))}`;
  }
  return `--${prefix ? prefix + '-' : ''}${path.map(kebab).join('-')}`;
}

/** `{primitive.grey.900}` → the token it names, and its CSS var. */
function makeResolver(doc) {
  const byRef = new Map();
  const names = new Map();
  for (const group of Object.keys(doc)) {
    if (group.startsWith('$')) continue;
    for (const [path, token] of walk(doc[group])) {
      const ref = `{${group}.${path.join('.')}}`;
      byRef.set(ref, { group, path, token });
      names.set(ref, cssName(group, path, token));
    }
  }
  const isRef = (v) => typeof v === 'string' && /^\{[^}]+\}$/.test(v);
  const resolve = (v, depth = 0) => {
    if (!isRef(v)) return v;
    const hit = byRef.get(v);
    if (!hit) throw new Error(`unknown token reference ${v}`);
    if (depth > 8) throw new Error(`alias loop at ${v}`);
    return resolve(hit.token.$value, depth + 1);
  };
  const asCss = (v) => (isRef(v) ? `var(${names.get(v)})` : v);
  return { byRef, names, isRef, resolve, asCss };
}

// quote a family name with a space in it; generic keywords (sans-serif, monospace) and
// -apple-system must stay bare
const fontStack = (arr) => arr.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ');

export function generate(doc = JSON.parse(readFileSync(TOKENS_JSON, 'utf8'))) {
  const { names, isRef, resolve, asCss } = makeResolver(doc);
  const lines = [];
  const touch = [];
  const ts = { color: {}, space: {}, radius: {}, size: {}, sizeTouch: {}, motion: {}, type: {} };
  const px = (s) => Number(String(s).replace(/px$/, ''));

  const emit = (group, label, render) => {
    lines.push(`  /* ${label} */`);
    for (const [path, token] of walk(doc[group])) {
      const name = cssName(group, path, token);
      const out = render(path, token, name);
      if (out === undefined) continue;
      for (const [n, v] of Array.isArray(out) ? out : [[name, out]]) lines.push(`  ${n}: ${v};`);
    }
  };

  emit('primitive', 'primitives — the raw values; components use the semantic names below', (path, t) => {
    ts.color[path.join('/')] = t.$value;
    return t.$value;
  });
  emit('semantic', 'semantic colour (Figma: Color)', (path, t, name) => {
    ts.color[path.join('/')] = resolve(t.$value);
    return asCss(t.$value);
  });
  emit('space', 'space', (path, t) => {
    ts.space[path.join('/')] = px(t.$value);
    return t.$value;
  });
  emit('radius', 'radius', (path, t) => {
    ts.radius[path.join('/')] = t.$value;
    return t.$value;
  });
  emit('size', 'size (Figma: Size, Value mode; the Touch mode follows)', (path, t, name) => {
    const key = path.join('/');
    ts.size[key] = px(t.$value);
    const modes = t.$extensions?.['com.light.figma']?.modes;
    if (modes?.Touch !== undefined) {
      ts.sizeTouch[key] = px(modes.Touch);
      touch.push(`  ${name}: ${modes.Touch};`);
    }
    return t.$value;
  });
  emit('type', 'type: families, weights, leading, sizes, then one set of properties per text style', (path, t, name) => {
    const key = path.join('/');
    if (path[0] === 'family') {
      ts.type[key] = fontStack(t.$value);
      return fontStack(t.$value);
    }
    if (path[0] === 'style') {
      const s = t.$value;
      const out = [];
      if (s.fontFamily) out.push([`${name}-family`, asCss(s.fontFamily)]);
      if (s.fontSize) {
        const sizeRef = `{type.size.${String(s.fontSize).replace(/px$/, '').replace('.', '_')}}`;
        out.push([`${name}-size`, names.has(sizeRef) ? `var(${names.get(sizeRef)})` : s.fontSize]);
      }
      if (s.fontWeight) {
        const w = { 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold' }[s.fontWeight];
        out.push([`${name}-weight`, w ? `var(--weight-${w})` : String(s.fontWeight)]);
      }
      if (s.letterSpacing) out.push([`${name}-tracking`, s.letterSpacing]);
      if (s.lineHeight) out.push([`${name}-leading`, String(s.lineHeight)]);
      ts.type[key] = s;
      return out;
    }
    ts.type[key] = t.$value;
    return String(t.$value);
  });
  emit('elevation', 'elevation', (path, t) => {
    const s = t.$value;
    return `${s.offsetX} ${s.offsetY} ${s.blur}${s.spread ? ` ${s.spread}` : ''} ${asCss(s.color)}`;
  });
  emit('motion', 'motion', (path, t) => {
    ts.motion[path.join('/')] = Number(String(t.$value).replace(/ms$/, ''));
    return t.$value;
  });

  const head = `/* GENERATED by scripts/build-tokens.mjs from docs/design/tokens.json — do not edit.
   Figma (LIGHT Design System) is the source of truth: change it there, re-export
   tokens.json, run \`npm run tokens\`. \`npm run typecheck\` fails while this is stale. */\n`;
  const css =
    head +
    `:root {\n${lines.join('\n')}\n}\n\n` +
    `/* Size collection, Touch mode — the tablet density (review M14). Nothing else\n   changes here: theme.css reads the same names and the rest follows. */\n.app.touch {\n${touch.join('\n')}\n}\n`;

  const tsHead = `// GENERATED by scripts/build-tokens.mjs from docs/design/tokens.json — do not edit.
// The design tokens for code that lays out or paints without CSS: the grid's
// column widths, the canvas and scene colours, the panel floors. Sizes and
// spaces are px numbers; colours are resolved hex.\n`;
  const lit = (o) => JSON.stringify(o, null, 2).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:');
  const tsOut =
    tsHead +
    `export const color = ${lit(ts.color)} as const;\n\n` +
    `export const space = ${lit(ts.space)} as const;\n\n` +
    `export const radius = ${lit(ts.radius)} as const;\n\n` +
    `export const size = ${lit(ts.size)} as const;\n\n` +
    `/** the Touch-mode values of the sizes that have one */\nexport const sizeTouch = ${lit(ts.sizeTouch)} as const;\n\n` +
    `export const motion = ${lit(ts.motion)} as const;\n`;
  return { css, ts: tsOut, names };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { css, ts } = generate();
  writeFileSync(OUT_CSS, css);
  writeFileSync(OUT_TS, ts);
  console.log(`wrote ${OUT_CSS}\nwrote ${OUT_TS}`);
}
