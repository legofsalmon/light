// Export the LIGHT Design System's variables and styles from Figma in the
// docs/design/tokens.json shape. Read-only. Run it through the Figma MCP
// `use_figma` tool (or paste into the plugin console) on the design file
// (zK5Atg0210cM8IxDf8R8PL); the return value is the JSON to save over
// docs/design/tokens.json, then `npm run tokens`.
//
// Figma is the source of truth: this is how a change made there reaches the
// CSS, and `npm run typecheck` fails until it has.
//
// Collections → groups: Primitives → primitive, Color → semantic, Space, Radius,
// Size, Motion by name, Type → type (family/, weight/, line-height/, size/);
// text styles → type/style/*; effect styles → elevation/*. Aliases become
// `{group.path}` references; the Size collection's Touch mode becomes
// `$extensions.com.light.figma.modes`; a variable's WEB code syntax, when it
// differs from the generated name, becomes `$extensions.com.light.css`.
const GROUP = { Primitives: 'primitive', Color: 'semantic', Space: 'space', Radius: 'radius', Size: 'size', Type: 'type', Motion: 'motion' };
const TYPE_OF = { primitive: 'color', semantic: 'color', space: 'dimension', radius: 'dimension', size: 'dimension', motion: 'duration' };

// + epsilon: 0.9 × 255 is 229.49999… in floating point, and the token says e6
const hex2 = (x) => Math.round(x * 255 + 1e-6).toString(16).padStart(2, '0');
const hex = (c) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a !== undefined && c.a < 1 ? hex2(c.a) : ''}`;
const px = (v) => `${Number.isInteger(v) ? v : Number(v.toFixed(2))}px`;

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const variables = await figma.variables.getLocalVariablesAsync();
const byId = new Map(variables.map((v) => [v.id, v]));
const collById = new Map(collections.map((c) => [c.id, c]));

/** A variable's token path: Space, Radius, Size and Motion name their variables
 *  with the collection as a prefix (`size/topbar`), which the group already
 *  says; Type's `leading/*` are the line-height multipliers. */
const pathOf = (v) => {
  const coll = collById.get(v.variableCollectionId);
  const group = GROUP[coll.name];
  let name = v.name;
  if (['space', 'radius', 'size', 'motion'].includes(group)) name = name.replace(new RegExp(`^${group}/`), '');
  if (group === 'type') name = name.replace(/^leading\//, 'line-height/');
  return { group, name };
};
/** `{group.path}` for a variable */
const refOf = (v) => {
  const { group, name } = pathOf(v);
  return `{${group}.${name.split('/').join('.')}}`;
};
// The family variables hold the Figma font (SF Pro, Geist Mono); the CSS stack
// the token means is fixed here and the Figma name travels as an extension.
const FAMILY_STACK = { 'SF Pro': ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'], 'Geist Mono': ['ui-monospace', 'SF Mono', 'Menlo', 'monospace'] };
const WEIGHT_OF = { Regular: 400, Medium: 500, Semibold: 600, 'Semi Bold': 600, Bold: 700 };

const out = {};
const put = (group, name, token) => {
  const parts = name.split('/');
  let g = out[group] || (out[group] = {});
  for (const p of parts.slice(0, -1)) g = g[p] || (g[p] = {});
  g[parts[parts.length - 1]] = token;
};

const valueOf = (v, coll, modeId) => {
  const raw = v.valuesByMode[modeId];
  if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') return refOf(byId.get(raw.id));
  const group = GROUP[coll.name];
  if (v.resolvedType === 'COLOR') return hex(raw);
  // Motion holds seconds (0.12), with the float noise a 32-bit store adds
  if (group === 'motion') { const n = Number(raw); return `${Math.round(n < 10 ? n * 1000 : n)}ms`; }
  if (v.resolvedType === 'FLOAT') {
    if (group === 'radius') return v.name.endsWith('/pill') ? '50%' : px(raw);
    if (group === 'type') return v.name.startsWith('size/') ? px(raw) : v.name.startsWith('leading/') ? raw / 100 : raw;
    return px(raw);
  }
  if (group === 'type' && v.name.startsWith('weight/')) return WEIGHT_OF[raw] ?? Number(raw);
  return raw;
};

for (const coll of collections) {
  const group = GROUP[coll.name];
  if (!group) continue;
  const base = coll.modes[0];
  const extra = coll.modes.slice(1);
  for (const id of coll.variableIds) {
    const v = byId.get(id);
    if (!v) continue;
    // Type: tracking references (a PERCENT that would apply as px) are not
    // exported; leading/* are the line-height multipliers
    if (group === 'type' && /^tracking\//.test(v.name)) continue;
    const { name } = pathOf(v);
    const token = {};
    token.$type =
      group === 'type'
        ? v.name.startsWith('family/') ? 'fontFamily' : v.name.startsWith('weight/') ? 'fontWeight' : v.name.startsWith('size/') ? 'dimension' : 'number'
        : TYPE_OF[group];
    if (group === 'type' && name.startsWith('line-height/')) token.$type = 'number';
    let value = valueOf(v, coll, base.modeId);
    const ext = {};
    if (token.$type === 'fontFamily' && typeof value === 'string') {
      ext['com.light.figma'] = { font: value };
      value = FAMILY_STACK[value] || value.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    }
    token.$value = value;
    if (v.description) token.$description = v.description;
    if (extra.length) {
      const modes = { [base.name]: value };
      for (const m of extra) {
        const mv = valueOf(v, coll, m.modeId);
        if (mv !== value) modes[m.name] = mv;
      }
      if (Object.keys(modes).length > 1) ext['com.light.figma'] = { modes };
    }
    const web = v.codeSyntax && v.codeSyntax.WEB;
    if (web && /^--[a-z0-9-]+$/.test(web)) {
      // only a name that is not the systematic one is worth recording — the
      // generator derives the rest (scripts/build-tokens.mjs cssName)
      const k = (s) => s.replace(/_/g, '-').replace(/\//g, '-');
      const systematic = { primitive: `--${k(name)}`, semantic: `--color-${k(name)}`, space: `--space-${k(name)}`, radius: `--radius-${k(name)}`, size: `--size-${k(name)}`, motion: `--motion-${k(name)}` }[group]
        ?? (name.startsWith('weight/') ? `--weight-${k(name.slice(7))}` : name.startsWith('line-height/') ? `--leading-${k(name.slice(12))}` : name.startsWith('size/') ? `--font-size-${k(name.slice(5))}` : null);
      if (web !== systematic) ext['com.light.css'] = web;
    }
    if (Object.keys(ext).length) token.$extensions = ext;
    put(group, name, token);
  }
}

// text styles → type/style/*
const weightOf = { Regular: 400, Medium: 500, Semibold: 600, 'Semi Bold': 600, Bold: 700 };
for (const s of await figma.getLocalTextStylesAsync()) {
  if (!s.name.startsWith('text/')) continue;
  const value = {};
  if (s.fontName.family !== 'SF Pro') value.fontFamily = '{type.family.mono}';
  value.fontSize = px(s.fontSize);
  const w = weightOf[s.fontName.style];
  if (w && w !== 400) value.fontWeight = w;
  if (s.letterSpacing && s.letterSpacing.unit === 'PERCENT' && s.letterSpacing.value) value.letterSpacing = `${Number((s.letterSpacing.value / 100).toFixed(3))}em`;
  if (s.letterSpacing && s.letterSpacing.unit === 'PIXELS' && s.letterSpacing.value) value.letterSpacing = px(s.letterSpacing.value);
  if (s.lineHeight && s.lineHeight.unit === 'PERCENT') value.lineHeight = Number((s.lineHeight.value / 100).toFixed(3));
  if (s.lineHeight && s.lineHeight.unit === 'PIXELS') value.lineHeight = px(s.lineHeight.value);
  if (s.textCase === 'UPPER') value.textCase = 'upper';
  const token = { $type: 'typography', $value: value };
  if (s.description) token.$description = s.description;
  put('type', `style/${s.name.slice('text/'.length)}`, token);
}

// effect styles → elevation/*
for (const s of await figma.getLocalEffectStylesAsync()) {
  if (!s.name.startsWith('elevation/')) continue;
  const e = s.effects.find((x) => x.type === 'DROP_SHADOW');
  if (!e) continue;
  const bound = e.boundVariables && e.boundVariables.color;
  const color = bound ? refOf(byId.get(bound.id)) : hex(e.color);
  const token = { $type: 'shadow', $value: { offsetX: e.offset.x ? px(e.offset.x) : '0', offsetY: e.offset.y ? px(e.offset.y) : '0', blur: px(e.radius), color } };
  if (e.spread) token.$value.spread = px(e.spread);
  if (s.description) token.$description = s.description;
  put('elevation', s.name.slice('elevation/'.length), token);
}

return out;
