#!/usr/bin/env node
// The language lint: user-visible strings in the UI must use the app's own
// vocabulary — pad, look, song, rig, stage, dial, nudge — and never the desk
// words the review retired (docs/design/system.md, "The language problem").
//
// It walks every .ts/.tsx under ui/src with the TypeScript compiler, collects
// the strings a person can read (JSX text, title/placeholder/label props,
// dialog and toast copy, `help:`/`title:` table entries) and fails on a
// retired word. Identifiers, class names and protocol values are not strings
// a person reads, so `deckId`, `className="cell"` and `blend: 'htp'` pass.
//
//   node scripts/check-language.mjs          # exit 1 on any hit
//   node scripts/check-language.mjs --list   # print every visible string
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'ui', 'src');

// Words that must not appear in anything a person reads. `say` is what to
// write instead — it is printed with the hit so the fix is in the message.
const RETIRED = [
  { re: /\bdecks?\b/i, say: 'song' },
  { re: /\bcells?\b/i, say: 'pad' },
  { re: /\bpreviz\b/i, say: 'stage' },
  { re: /\bLFOs?\b/, say: 'pulse' },
  { re: /\bmodulators?\b/i, say: 'pulse' },
  { re: /\bmacros?\b/i, say: 'dial' },
  { re: /\bnamed controls?\b/i, say: 'dials' },
  { re: /\b(ride|rides|riding|rode)\b/i, say: 'nudge / nudged' },
  { re: /\bsoft overrides?\b/i, say: 'nudge' },
  { re: /\bcue ?lists?\b/i, say: 'steps' },
  { re: /\bcue steps?\b/i, say: 'steps' },
  { re: /\bhtp\b/i, say: 'brightest wins' },
  { re: /\bcto\b/i, say: 'warmth' },
  { re: /\biris\b/i, say: 'beam size' },
  { re: /\bfrost\b/i, say: 'soften' },
  { re: /\btrim\b/i, say: 'hang height' },
  { re: /\bsaw ?(up|down)\b/i, say: 'ramp up / ramp down' },
  { re: /\bidx\b/i, say: 'in order' },
  { re: /\bseats?\b/i, say: 'activated on this Mac' },
  { re: /\blease\b/i, say: 'works offline until' },
  { re: /\bheartbeat\b/i, say: '(say what it does)' },
  { re: /\bidentify\b/i, say: 'find this light' },
  { re: /\b(SIZ|SPR|PH|MI)\b/, say: 'Size · Spread · Offset · Amount' },
  { re: /(?<!haze )(?<!haze-)\bfan\b/i, say: 'spread (effect) / haze fan (hazer)' },
  { re: /\bPatch\b|\bPATCH\b/, say: 'Rig (the view) / patch as a verb is fine in lowercase' },
];

// Protocol words a tech recognises — allowed in tooltips and help, not in a
// label. A label says what the control does; the tooltip may name the wire.
const TOOLTIP_ONLY = [
  { re: /\bArtPoll\b/, say: 'find nodes' },
  { re: /\bUDP\b/, say: '(tooltip only)' },
  { re: /\bunicast\b/i, say: 'send to this address' },
  { re: /\bbroadcast\b/i, say: 'send to everyone' },
  { re: /\bE1\.31\b/, say: '(tooltip only)' },
  // OSC is Arena's own word for the setting the operator must flip, so the
  // setup steps may name it; nothing of LIGHT's is called OSC.
  { re: /\bOSC\b/, say: 'Resolume link', unless: /Arena|Preferences/ },
];

const TOOLTIP_ATTRS = new Set(['title', 'help', 'hint', 'aria-label']);
const LABEL_ATTRS = new Set(['placeholder', 'label', 'alt', 'caption']); // not `value`: an <option value> is wire, not copy
const COPY_CALLS = new Set(['askConfirm', 'askPrompt', 'askChoice', 'askDanger', 'confirmDialog', 'toast', 'setToast', 'pushToast', 'describeAction', 'msg', 'say', 'push']);
const COPY_PROPS = new Set(['title', 'label', 'help', 'hint', 'desc', 'description', 'detail', 'text', 'message', 'body', 'caption', 'name', 'note', 'ok', 'cancel', 'yes', 'no', 'danger']);
// Functions whose return value is copy — describeAction, describe(status)…
const COPY_FUNCTIONS = /^describe/;

function enclosingFunctionName(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
    if (ts.isFunctionLike(p)) return '';
  }
  return '';
}

function* walkFiles(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walkFiles(p);
    else if (/\.tsx?$/.test(f) && !f.endsWith('.d.ts')) yield p;
  }
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => ' … ' + s.literal.text).join('');
  return null;
}

// Every string-ish node reachable through the expression forms copy takes:
// conditionals, || / ?? fallbacks, parentheses, arrays and object values.
function* strings(node) {
  if (!node) return;
  const t = literalText(node);
  if (t !== null) { yield [t, node]; return; }
  if (ts.isParenthesizedExpression(node)) yield* strings(node.expression);
  else if (ts.isConditionalExpression(node)) { yield* strings(node.whenTrue); yield* strings(node.whenFalse); }
  else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) { yield* strings(node.left); yield* strings(node.right); }
  else if (ts.isArrayLiteralExpression(node)) for (const e of node.elements) yield* strings(e);
  else if (ts.isJsxExpression(node)) yield* strings(node.expression);
}

function collect(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  // `ctx` is the surrounding paragraph for a JSX text node — a <b>OSC Output</b>
  // inside "Arena ▸ Preferences ▸ OSC → enable …" is judged with its sentence.
  const add = (kind, s, node, ctx = '') => { const v = s.replace(/\s+/g, ' ').trim(); if (v.length > 1) out.push({ kind, text: v, ctx, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 }); };
  const visit = (node) => {
    if (ts.isJsxText(node)) { add('label', node.text, node, node.parent && node.parent.parent ? node.parent.parent.getText(sf) : ''); }
    else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const kind = TOOLTIP_ATTRS.has(name) ? 'tooltip' : LABEL_ATTRS.has(name) ? 'label' : null;
      if (kind) for (const [s, n] of strings(node.initializer)) add(kind, s, n);
    }
    else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const [s, n] of strings(node.expression)) add('label', s, n);
    }
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (COPY_CALLS.has(name)) for (const a of node.arguments) for (const [s, n] of strings(a)) add('label', s, n);
    }
    else if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (COPY_PROPS.has(name)) for (const [s, n] of strings(node.initializer)) add(['help', 'hint', 'title', 'desc', 'description'].includes(name) ? 'tooltip' : 'label', s, n);
    }
    else if (ts.isReturnStatement(node) && node.expression && COPY_FUNCTIONS.test(enclosingFunctionName(node))) {
      for (const [s, n] of strings(node.expression)) add('label', s, n);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const list = process.argv.includes('--list');
let hits = 0, seen = 0;
for (const file of walkFiles(SRC)) {
  const rel = relative(ROOT, file);
  for (const { kind, text, ctx, line } of collect(file)) {
    seen++;
    if (list) console.log(`${rel}:${line} [${kind}] ${text}`);
    const rules = kind === 'tooltip' ? RETIRED : [...RETIRED, ...TOOLTIP_ONLY];
    for (const r of rules) {
      const m = text.match(r.re);
      if (m && !(r.unless && (r.unless.test(text) || r.unless.test(ctx)))) { hits++; console.log(`${rel}:${line} [${kind}] "${text}"\n    ↳ retired "${m[0]}" — say ${r.say}`); }
    }
  }
}
console.log(`\n${seen} visible strings, ${hits} retired-word hit${hits === 1 ? '' : 's'}`);
process.exit(hits ? 1 : 0);
