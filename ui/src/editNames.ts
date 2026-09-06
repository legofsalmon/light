// What the undo button will revert, in the operator's words (review M16):
// "undo rename song", not "undo". The name is derived from the difference
// between the project before and after an edit at the mutate() choke point,
// so every edit gets one without each of the sixty call sites having to say
// it — a call site that knows better passes its own label.
//
// Runs only when a history entry is actually pushed (coalesced drags do not
// re-run it), and costs two JSON stringifies of the project — the same order
// as the structuredClone the entry already takes.
//
// Every string here is copy: the helpers are named describe* so the language
// lint reads their return statements.
import type { Deck, Fixture, Layer, Look, Project, StageProp, UniverseCfg } from '../../shared/types.ts';
import { PROP_LABEL } from './labels.ts';

const j = (v: unknown): string => JSON.stringify(v) ?? '';
const q = (s: string): string => `“${s}”`;

/** added / removed / changed / reordered between two id-keyed lists */
function diffList<T extends { id: string }>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  const ma = new Map((a ?? []).map((x) => [x.id, x]));
  const mb = new Map((b ?? []).map((x) => [x.id, x]));
  const added = [...mb.values()].filter((x) => !ma.has(x.id));
  const removed = [...ma.values()].filter((x) => !mb.has(x.id));
  const changed = [...mb.values()]
    .filter((x) => ma.has(x.id) && j(ma.get(x.id)) !== j(x))
    .map((x) => [ma.get(x.id)!, x] as [T, T]);
  const reordered =
    added.length === 0 && removed.length === 0 && (a ?? []).some((x, i) => (b ?? [])[i]?.id !== x.id);
  return { added, removed, changed, reordered };
}

function describeLook(a: Look, b: Look): string {
  const name = q(b.name);
  if (a.name !== b.name) return `rename look ${name}`;
  if (a.parts.length < b.parts.length) return `add a part to ${name}`;
  if (a.parts.length > b.parts.length) return `remove a part from ${name}`;
  if ((a.fade ?? null) !== (b.fade ?? null)) return `fade of ${name}`;
  if (!!a.flash !== !!b.flash) return `flash on ${name}`;
  if (j(a.steps) !== j(b.steps)) return `steps of ${name}`;
  if (a.parts.some((p, i) => j(p.effects) !== j(b.parts[i]?.effects))) return `effects in ${name}`;
  return `edit look ${name}`;
}

function describeFixtureVerb(a: Fixture, b: Fixture): string {
  if (a.name !== b.name) return 'rename';
  if (j(a.pos) !== j(b.pos)) return 'move';
  if (a.rotY !== b.rotY || a.rotX !== b.rotX || a.rotZ !== b.rotZ) return 'turn';
  if (a.address !== b.address || a.universeId !== b.universeId) return 're-address';
  if (a.profileId !== b.profileId) return 'change the profile of';
  if (a.pan !== b.pan || a.tilt !== b.tilt) return 'aim';
  if (a.parentId !== b.parentId) return 'rig';
  return 'edit';
}

function describeFixtures(a: Fixture[], b: Fixture[]): string[] {
  const d = diffList(a, b);
  const out: string[] = [];
  if (d.added.length === 1) out.push(`add ${q(d.added[0].name)}`);
  else if (d.added.length > 1) out.push(`add ${d.added.length} fixtures`);
  if (d.removed.length === 1) out.push(`delete ${q(d.removed[0].name)}`);
  else if (d.removed.length > 1) out.push(`delete ${d.removed.length} fixtures`);
  if (d.changed.length === 1) {
    const [x, y] = d.changed[0];
    out.push(`${describeFixtureVerb(x, y)} ${q(y.name)}`);
  } else if (d.changed.length > 1) {
    const verbs = new Set(d.changed.map(([x, y]) => describeFixtureVerb(x, y)));
    out.push(`${verbs.size === 1 ? [...verbs][0] : 'edit'} ${d.changed.length} fixtures`);
  }
  return out;
}

/** true when the change was to the pads (so a mirrored song change is not reported twice) */
function describeLayer(a: Layer, b: Layer, looks: Record<string, Look>): string {
  if (a.name !== b.name) return `rename layer ${q(b.name)}`;
  if (a.blend !== b.blend) return `blend of ${b.name}`;
  if (a.fade !== b.fade) return `fade of ${b.name}`;
  if (a.master !== b.master) return `master of ${b.name}`;
  // a length change is a column insert or delete, reported by the columns rule
  if (a.cells.length !== b.cells.length) return '';
  const diffs = b.cells
    .map((c, i) => [a.cells[i] ?? null, c ?? null] as const)
    .filter(([was, now]) => was !== now);
  if (diffs.length === 1) {
    const [was, now] = diffs[0];
    if (now === null) return `clear a pad on ${b.name}`;
    const look = looks[now]?.name;
    if (was === null) return look ? `place ${q(look)} on ${b.name}` : `place a pad on ${b.name}`;
    return look ? `put ${q(look)} on a pad of ${b.name}` : `swap a pad on ${b.name}`;
  }
  if (diffs.length > 1) return `pads on ${b.name}`;
  return `edit layer ${b.name}`;
}

function describeColumns(a: string[], b: string[]): string {
  if (b.length > a.length) return 'insert a column';
  if (b.length < a.length) return 'delete a column';
  const i = b.findIndex((c, k) => c !== a[k]);
  return i >= 0 ? `rename column ${q(b[i])}` : 'the columns';
}

function describeSongs(a: Deck[] | undefined, b: Deck[] | undefined, padsReported: boolean): string[] {
  const d = diffList(a, b);
  const out: string[] = [];
  for (const x of d.added) out.push(`new song ${q(x.name)}`);
  for (const x of d.removed) out.push(`delete song ${q(x.name)}`);
  if (d.reordered) out.push('reorder the songs');
  for (const [x, y] of d.changed) {
    if (x.name !== y.name) out.push(`rename song ${q(y.name)}`);
    else if (j(x.columns) !== j(y.columns)) out.push(describeColumns(x.columns, y.columns));
    else if (!padsReported && j(x.cells) !== j(y.cells)) out.push(`pads in ${q(y.name)}`);
  }
  return out;
}

function describeProp(a: StageProp, b: StageProp): string {
  const what = PROP_LABEL[b.kind] ?? b.kind;
  if (j(a.pos) !== j(b.pos)) return `move the ${what}`;
  if (a.rotY !== b.rotY) return `turn the ${what}`;
  if (j(a.size) !== j(b.size)) return `resize the ${what}`;
  if (a.y !== b.y) return `raise the ${what}`;
  return `edit the ${what}`;
}

function describeUniverse(a: UniverseCfg, b: UniverseCfg): string {
  const name = q(b.label);
  if (a.label !== b.label) return `rename universe ${name}`;
  if (a.artnet !== b.artnet || a.sacn !== b.sacn) return `output of ${name}`;
  return `output settings for ${name}`;
}

/** One short phrase for what changed between two project states — what the
 *  undo button will revert, or the redo button restore. */
export function describeEdit(a: Project, b: Project): string {
  const parts: string[] = [];
  const add = (s: string | string[]) => {
    for (const x of Array.isArray(s) ? s : [s]) if (x && !parts.includes(x)) parts.push(x);
  };
  if (a.name !== b.name) add('rename the show');

  if (j(a.looks) !== j(b.looks)) {
    const d = diffList(Object.values(a.looks), Object.values(b.looks));
    if (d.added.length === 1) add(`new look ${q(d.added[0].name)}`);
    else if (d.added.length > 1) add(`add ${d.added.length} looks`);
    if (d.removed.length === 1) add(`delete look ${q(d.removed[0].name)}`);
    else if (d.removed.length > 1) add(`delete ${d.removed.length} looks`);
    if (d.changed.length === 1) add(describeLook(d.changed[0][0], d.changed[0][1]));
    else if (d.changed.length > 1) add(`edit ${d.changed.length} looks`);
  }

  let padsReported = false;
  if (j(a.layers) !== j(b.layers)) {
    const d = diffList(a.layers, b.layers);
    if (d.added.length) add('add a layer');
    if (d.removed.length) add('delete a layer');
    for (const [x, y] of d.changed) {
      const s = describeLayer(x, y, b.looks);
      if (/\bpads?\b/.test(s)) padsReported = true;
      add(s);
    }
  }
  if (j(a.columns) !== j(b.columns)) add(describeColumns(a.columns, b.columns));
  if (j(a.decks) !== j(b.decks)) add(describeSongs(a.decks, b.decks, padsReported));
  if (a.activeDeckId !== b.activeDeckId) add('switch song');

  if (j(a.fixtures) !== j(b.fixtures)) add(describeFixtures(a.fixtures, b.fixtures));

  if (j(a.groups) !== j(b.groups)) {
    const d = diffList(a.groups, b.groups);
    for (const x of d.added) add(`new group ${q(x.name)}`);
    for (const x of d.removed) add(`delete group ${q(x.name)}`);
    for (const [x, y] of d.changed) {
      if (x.name !== y.name) add(`rename group ${q(y.name)}`);
      else if (j(x.heads) !== j(y.heads)) add(`members of group ${q(y.name)}`);
      else if (x.auto !== y.auto) add(`pin group ${q(y.name)}`);
      else add(`edit group ${q(y.name)}`);
    }
  }

  if (j(a.stage) !== j(b.stage)) add(!b.stage ? 'stage size back to auto' : !a.stage ? 'set the stage size' : 'resize the stage');
  if (j(a.props) !== j(b.props)) {
    const d = diffList(a.props, b.props);
    if (d.added.length === 1) add(`add a ${PROP_LABEL[d.added[0].kind] ?? d.added[0].kind}`);
    else if (d.added.length > 1) add(`add ${d.added.length} stage props`);
    if (d.removed.length === 1) add(`remove the ${PROP_LABEL[d.removed[0].kind] ?? d.removed[0].kind}`);
    else if (d.removed.length > 1) add(`remove ${d.removed.length} stage props`);
    if (d.changed.length === 1) add(describeProp(d.changed[0][0], d.changed[0][1]));
    else if (d.changed.length > 1) add(`move ${d.changed.length} stage props`);
  }

  if (j(a.universes) !== j(b.universes)) {
    const d = diffList(a.universes, b.universes);
    if (d.added.length) add('add a universe');
    for (const x of d.removed) add(`delete universe ${q(x.label)}`);
    for (const [x, y] of d.changed) add(describeUniverse(x, y));
  }

  if (j(a.midi) !== j(b.midi)) {
    const d = diffList(a.midi, b.midi);
    if (d.added.length > 3) add('apply a MIDI template');
    else if (d.added.length) add('map a MIDI control');
    if (d.removed.length) add('remove a MIDI mapping');
    if (d.changed.length) add('change a MIDI mapping');
  }
  if (j(a.sync) !== j(b.sync)) add('sync settings');
  if (j(a.settings) !== j(b.settings)) add('the haze');
  if (j(a.profiles) !== j(b.profiles)) {
    const d = diffList(Object.values(a.profiles ?? {}), Object.values(b.profiles ?? {}));
    if (d.changed.length === 1) add(`edit profile ${q(d.changed[0][1].model)}`);
    else add('the fixture profiles');
  }

  if (j(a.fxPool) !== j(b.fxPool)) {
    const d = diffList(a.fxPool, b.fxPool);
    if (d.added.length) add('save an effect to the pool');
    for (const x of d.removed) add(`delete pool effect ${q(x.name)}`);
    for (const [, y] of d.changed) add(`rename pool effect ${q(y.name)}`);
  }
  if (j(a.controls) !== j(b.controls)) {
    const d = diffList(a.controls, b.controls);
    for (const x of d.added) add(`new dial ${q(x.name)}`);
    for (const x of d.removed) add(`delete dial ${q(x.name)}`);
    for (const [x, y] of d.changed) add(x.name !== y.name ? `rename dial ${q(y.name)}` : j(x.links) !== j(y.links) ? `links of dial ${q(y.name)}` : `edit dial ${q(y.name)}`);
  }
  if (j(a.modulators) !== j(b.modulators)) {
    const d = diffList(a.modulators, b.modulators);
    for (const x of d.added) add(`new pulse ${q(x.name)}`);
    for (const x of d.removed) add(`delete pulse ${q(x.name)}`);
    for (const [x, y] of d.changed) add(x.name !== y.name ? `rename pulse ${q(y.name)}` : `edit pulse ${q(y.name)}`);
  }

  if (parts.length === 0) return 'the last edit';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]} and ${parts.length - 1} more`;
}
