// One effect on a part: what the wave does on line 1, and how it is spread
// across the group on line 2 — which is folded, and says what it holds while
// folded, so a look reads at a glance and opens only when it is being changed.

import React from 'react';
import type { Distribute, Effect, EffectTarget, ShapeKind, SoftField, Wave } from '../../../../shared/types.ts';
import { EFFECT_TARGETS, SHAPE_KINDS } from '../../../../shared/types.ts';
import type { HeadKind } from '../../../../shared/profiles.ts';
import type { BeamCaps } from '../../profileInfo.ts';
import { DISTRIBUTE_WORD, SHAPE_LABEL, TARGET_LABEL, WAVE_LABEL } from '../../labels.ts';
import { Fader, fmtPct } from '../Fader.tsx';
import { Glyph, type GlyphName } from '../../glyphs.tsx';
import { DialMenu, IntInput } from './fields.tsx';
import { capableTargets } from './groups.ts';
import { type SpreadPreview, useEditorStore } from '../../editorStore.ts';
import { useStore } from '../../store.ts';

/** Beats per cycle, by the musical length an operator would say. */
export const RATES: { v: number; label: string }[] = [
  { v: 32, label: '8 bars' },
  { v: 16, label: '4 bars' },
  { v: 8, label: '2 bars' },
  { v: 4, label: '1 bar' },
  { v: 2, label: '2 beats' },
  { v: 1, label: '1 beat' },
  { v: 0.5, label: '1/2' },
  { v: 0.25, label: '1/4' },
];

const WAVES: Wave[] = ['sine', 'triangle', 'sawUp', 'sawDown', 'square', 'chase', 'random'];

/** Spread bases in display order, with the labels the operators know. */
/** Spread bases in display order. The picture is the label here — these are
 *  the one set in the app where a drawing beats a word, because each says a
 *  DIRECTION across the rig, and eight words at 9px say nothing at a glance
 *  (design 3.3). The words stay in the help and in the folded line's summary. */
const DISTRIBUTE_LABELS: { v: Distribute; glyph: GlyphName; title: string }[] = [
  { v: 'index', glyph: 'spread-order', title: 'patch order — the classic spread, one after another' },
  { v: 'x', glyph: 'spread-x', title: 'sweep stage left → right (world position)' },
  { v: 'y', glyph: 'spread-y', title: 'sweep bottom → top' },
  { v: 'z', glyph: 'spread-z', title: 'sweep upstage → downstage' },
  { v: 'radial', glyph: 'spread-radial', title: 'ripple out from the group centre' },
  { v: 'shuffle', glyph: 'spread-shuffle', title: 'seeded scatter — re-roll with the reshuffle key, same seed = same look' },
  { v: 'row', glyph: 'spread-row', title: 'sweep each fixture’s own pixel rows — every fixture runs the same wave' },
  { v: 'col', glyph: 'spread-col', title: 'sweep each fixture’s own pixel columns — every fixture runs the same wave' },
];

/** The musical length this rate is locked to. */
export const rateLabel = (rate: number): string =>
  RATES.find((r) => r.v === rate)?.label ?? `${rate} beats`;

/** ...and the same rate as a tempo, which is the unit the room is in. The wave
 *  moves as if its cycle were a bar, so at 120.0 BPM an eight-bar cycle reads
 *  `15 BPM` — slow enough that you can see it is slow before you fire it
 *  (design 2.6). Empty when there is no tempo to resolve it against. */
export function rateBpm(rate: number, bpm: number, speed: number): string {
  const bars = rate / 4;
  const at = bpm * speed;
  if (!(bars > 0) || !(at > 0)) return '';
  const asBpm = at / bars;
  return `${asBpm >= 10 ? Math.round(asBpm) : asBpm.toFixed(1)} BPM`;
}

/** The pair, as the design writes it: `8 bars = 15 BPM`. */
export function rateWords(rate: number, bpm: number, speed: number): string {
  const at = rateBpm(rate, bpm, speed);
  return at ? `${rateLabel(rate)} = ${at}` : rateLabel(rate);
}

/** What line 2 holds, said in one line so it does not have to be opened to be
 *  read: the spread's base, whatever folding is on, and the two counts. */
export function spreadWords(fx: Effect): string {
  const bits = [DISTRIBUTE_WORD[fx.distribute]];
  if (fx.fold === 'mirror') bits.push('mirrored');
  if (fx.fold === 'centre') bits.push('middle leads');
  if (fx.reverse) bits.push('backwards');
  bits.push(`tile ${fx.parts}`);
  bits.push(`buddy ${fx.buddy}`);
  return `spread: ${bits.join(' · ')}`;
}

export function EffectRow({ fx, kinds, canAim, beamCaps, headsPerFixture, lookId, partId, onEdit, onRemove, onSaveToPool, onField, soft }: {
  fx: Effect;
  kinds: Set<HeadKind>;
  canAim: boolean;
  beamCaps: BeamCaps;
  /** emitters per fixture, where the group agrees — what "per strip" means */
  headsPerFixture?: number;
  lookId: string;
  partId: string;
  onEdit: (fn: (e: Effect) => void) => void;
  onRemove: () => void;
  onSaveToPool: () => void;
  /** P1 router: numeric knobs go through here (nudge mode sends soft) */
  onField: (field: SoftField, v: number, fallback: (e: Effect) => void) => void;
  /** live soft value for one of this effect's fields, if nudged */
  soft: (field: SoftField) => number | undefined;
}) {
  const bpm = useStore((s) => s.snap?.bpm ?? 120);
  const speed = useStore((s) => s.snap?.speed ?? 1);
  const open = useEditorStore((s) => !!s.spreadOpen[fx.id]);
  const toggleSpread = useEditorStore((s) => s.toggleSpread);
  const setSpreadPreview = useEditorStore((s) => s.setSpreadPreview);

  /** A39: while this row's spread is open — or just under the pointer — the
   *  plan numbers the group's heads in the order the spread will run them.
   *  The store holds the address, not a copy, so changing the basis below
   *  re-numbers on the next frame. */
  const mine: SpreadPreview = { lookId, partId, effectId: fx.id };
  const isMine = (p: SpreadPreview | null): boolean =>
    !!p && p.effectId === fx.id && p.partId === partId && p.lookId === lookId;
  // what the plan was showing before the pointer arrived, so leaving the line
  // puts it back rather than blanking another row's open disclosure
  const under = React.useRef<SpreadPreview | null>(null);
  React.useEffect(() => {
    if (open) setSpreadPreview(mine);
    return () => {
      if (isMine(useEditorStore.getState().spreadPreview)) setSpreadPreview(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lookId, partId, fx.id, setSpreadPreview]);

  const capable = capableTargets(kinds, canAim, beamCaps);
  // inform, don't forbid: every target stays assignable (an effect is
  // interchangeable across groups), the ones this group can't take are just
  // grouped apart and the current target is flagged if it lands there.
  const capableSet = new Set(capable);
  const others = [...EFFECT_TARGETS].filter((t) => !capableSet.has(t));
  const targetInactive = !capableSet.has(fx.target);
  const rate = soft('rate') ?? fx.rate;

  /** The numeric addresses this row carries, for `→ dial`. */
  const rowFields: SoftField[] = ['rate', 'size', 'spread', 'phase', 'mix'];

  return (
    <>
    <div className="fxrow" style={fx.bypass ? { opacity: 0.5 } : undefined}>
      <button
        className={`btn small ${fx.bypass ? 'on' : 'ghost'}`}
        style={{ width: 30 }}
        title={fx.bypass ? 'parked — click to enable' : 'park this effect (keeps it, stops its output)'}
        onClick={() => onEdit((x) => (x.bypass = !x.bypass))}
      >
        {fx.bypass ? '▷' : '❙❙'}
      </button>
      <select className="sel" title="which parameter the wave moves. Targets this group cannot take are still assignable, and flagged" value={fx.target} onChange={(e) => onEdit((x) => (x.target = e.target.value as EffectTarget))}>
        <optgroup label="drives this group">
          {capable.map((t) => (
            <option key={t} value={t}>{TARGET_LABEL[t]}</option>
          ))}
        </optgroup>
        {others.length > 0 && (
          <optgroup label="no fixtures here (still assignable)">
            {others.map((t) => (
              <option key={t} value={t}>{TARGET_LABEL[t]}</option>
            ))}
          </optgroup>
        )}
      </select>
      {targetInactive && (
        <span className="label" title="nothing in this group takes this parameter — it does nothing here until the effect is retargeted or dropped on a group that has it" style={{ color: 'var(--color-status-nudge)' }}>
          ⚠
        </span>
      )}
      {fx.target === 'shape' ? (
        <select
          className="sel"
          title="which figure the heads trace. The figure IS the waveform here, so there is no wave to pick"
          value={fx.shape ?? 'circle'}
          onChange={(e) => onEdit((x) => (x.shape = e.target.value as ShapeKind))}
        >
          {SHAPE_KINDS.map((k) => (
            <option key={k} value={k}>{SHAPE_LABEL[k]}</option>
          ))}
        </select>
      ) : (
        <select className="sel" title="the wave shape — chase runs one head at a time and forces a full spread" value={fx.wave} onChange={(e) => onEdit((x) => (x.wave = e.target.value as Wave))}>
          {WAVES.map((w) => (
            <option key={w} value={w}>{WAVE_LABEL[w]}</option>
          ))}
        </select>
      )}
      <select
        className="sel"
        title="beats per cycle — 4 is one cycle per bar in 4/4. Musical, not hertz, so the rig stays in time when the tempo moves"
        value={String(rate)}
        onChange={(e) => onField('rate', Number(e.target.value), (x) => (x.rate = Number(e.target.value)))}
      >
        {RATES.map((r) => (
          <option key={r.v} value={String(r.v)}>{r.label}</option>
        ))}
      </select>
      {/* The same rate in the unit the room is in: a cycle this long runs at
          this tempo, right now, speed master included. */}
      <span className="label" title="the same rate as a tempo — what this cycle comes to at the speed the show is running. It moves when the tempo does, because the rate is musical">
        = {rateBpm(rate, bpm, speed)}
      </span>
      <Fader label="size" width={104} value={soft('size') ?? fx.size} nudged={soft('size') !== undefined} def={1} onChange={(v) => onField('size', v, (x) => (x.size = v))} fmt={fmtPct} variant="dim" />
      <Fader label="spread" width={104} value={soft('spread') ?? fx.spread} nudged={soft('spread') !== undefined} def={0} onChange={(v) => onField('spread', v, (x) => (x.spread = v))} fmt={fmtPct} variant="dim" />
      {fx.target !== 'shape' && (fx.wave === 'square' || fx.wave === 'chase') && (
        <Fader label="width" width={104} value={soft('width') ?? fx.width} nudged={soft('width') !== undefined} def={0.5} onChange={(v) => onField('width', v, (x) => (x.width = v))} fmt={fmtPct} variant="dim" />
      )}
      {fx.target === 'shape' && (
        <>
          <Fader
            label="aspect"
            width={104}
            value={fx.shapeAspect ?? 0.5}
            def={0.5}
            help="round in the middle; all the way left is a flat pan sweep and all the way right a vertical bounce"
            onChange={(v) => onEdit((x) => (x.shapeAspect = v))}
            fmt={fmtPct}
            variant="dim"
          />
          <Fader
            label="turn"
            width={104}
            value={fx.shapeRotate ?? 0}
            def={0}
            help="turn the whole figure — a sideways figure of eight becomes an upright one at 25%"
            onChange={(v) => onEdit((x) => (x.shapeRotate = v))}
            fmt={fmtPct}
            variant="dim"
          />
          <button
            className={`btn small ${fx.shapeCcw ? 'on' : 'ghost'}`}
            title={fx.shapeCcw ? 'tracing anticlockwise — click for clockwise' : 'tracing clockwise — click for anticlockwise'}
            onClick={() => onEdit((x) => (x.shapeCcw = !x.shapeCcw))}
          >
            {fx.shapeCcw ? '↺' : '↻'}
          </button>
        </>
      )}
      <Fader label="phase" width={104} value={soft('phase') ?? fx.phase} nudged={soft('phase') !== undefined} def={0} onChange={(v) => onField('phase', v, (x) => (x.phase = v))} fmt={fmtPct} variant="dim" />
      {/* wet/dry: how much of the effect lands. 100% is full effect. */}
      <Fader label="mix" width={104} value={soft('mix') ?? fx.mix} nudged={soft('mix') !== undefined} def={1} onChange={(v) => onField('mix', v, (x) => (x.mix = v))} fmt={fmtPct} variant="dim" />
      <DialMenu lookId={lookId} partId={partId} effectId={fx.id} fields={rowFields} />
      <button className="btn small ghost" title="save this effect to the FX pool as a reusable preset" onClick={onSaveToPool}>☆</button>
      <button title="remove this effect" className="btn small ghost" onClick={onRemove}><Glyph name="clear" alone /></button>
    </div>

    {/* Line 2, folded. It says what it holds, so the spread reads without
        being opened and opens only when it is being changed. */}
    <button
      className="spreadline"
      aria-expanded={open}
      style={fx.bypass ? { opacity: 0.5 } : undefined}
      title="how the wave is handed out across the group — open to change the base, the folding and the two counts. The plan numbers the heads in the order it will run them"
      onPointerEnter={() => {
        under.current = useEditorStore.getState().spreadPreview;
        setSpreadPreview(mine);
      }}
      onPointerLeave={() => {
        if (isMine(useEditorStore.getState().spreadPreview)) setSpreadPreview(open ? mine : under.current);
      }}
      onClick={() => toggleSpread(fx.id)}
    >
      <span className="caret">{open ? '▾' : '▸'}</span>
      {spreadWords(fx)}
    </button>

    {open && (
      <div className="fxrow" style={{ ...(fx.bypass ? { opacity: 0.5 } : {}), paddingLeft: 34 }}>
        <div className="seg">
          {DISTRIBUTE_LABELS.map((d) => (
            <button
              key={d.v}
              className={fx.distribute === d.v ? 'on' : ''}
              title={d.title}
              onClick={() => onEdit((x) => (x.distribute = d.v))}
            >
              <Glyph name={d.glyph} alone />
            </button>
          ))}
        </div>
        <button
          className={`btn small ${fx.fold === 'mirror' ? 'on' : 'ghost'}`}
          title="mirror — ends in phase, sweeping toward the centre; a folded pan sweep counter-rotates"
          onClick={() => onEdit((x) => (x.fold = x.fold === 'mirror' ? 'none' : 'mirror'))}
        >
          ⟷
        </button>
        <button
          className={`btn small ${fx.fold === 'centre' ? 'on' : 'ghost'}`}
          title="centre — the middle leads, the ends trail"
          onClick={() => onEdit((x) => (x.fold = x.fold === 'centre' ? 'none' : 'centre'))}
        >
          ◇
        </button>
        <button
          className={`btn small ${fx.reverse ? 'on' : 'ghost'}`}
          title="run the spread backwards"
          onClick={() => onEdit((x) => (x.reverse = !x.reverse))}
        >
          ⇄
        </button>
        <span className="label">tile</span>
        <IntInput
          value={fx.parts}
          min={1}
          max={64}
          title="tile the spread into k repeats across the group"
          onCommit={(v) => onEdit((x) => (x.parts = v))}
        />
        {/* Granularity in words. "buddy 12" means nothing until you know a
            fixture has twelve pixels; "per strip" is the same number said in
            the shape of the rig. Only offered where the group agrees on a
            head count, because one number would be a lie about the others. */}
        {headsPerFixture !== undefined ? (
          <>
            <span className="label">each step moves</span>
            <div className="seg">
              <button
                className={fx.buddy === 1 ? 'on' : ''}
                title="one emitter at a time — the wave runs through every pixel of every fixture"
                onClick={() => onEdit((x) => (x.buddy = 1))}
              >
                per pixel
              </button>
              <button
                className={fx.buddy === headsPerFixture ? 'on' : ''}
                title={`a whole fixture at a time — its ${headsPerFixture} emitters share one phase`}
                onClick={() => onEdit((x) => (x.buddy = headsPerFixture))}
              >
                per strip
              </button>
            </div>
            {fx.buddy !== 1 && fx.buddy !== headsPerFixture && (
              <IntInput
                value={fx.buddy}
                min={1}
                max={64}
                title="clump size — adjacent emitters share a phase"
                onCommit={(v) => onEdit((x) => (x.buddy = v))}
              />
            )}
          </>
        ) : (
          <>
            <span className="label">buddy</span>
            <IntInput
              value={fx.buddy}
              min={1}
              max={64}
              title="clump size — adjacent heads share a phase"
              onCommit={(v) => onEdit((x) => (x.buddy = v))}
            />
          </>
        )}
        {fx.distribute === 'shuffle' && (
          <button
            className="btn small ghost"
            title={`re-roll the scatter (seed ${fx.seed})`}
            onClick={() => onEdit((x) => (x.seed = Math.floor(Math.random() * 0x7fffffff)))}
          >
            ↻
          </button>
        )}
      </div>
    )}
    </>
  );
}
