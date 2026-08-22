import React, { useEffect, useState } from 'react';
import type { Distribute, Effect, EffectTarget, Look, LookPart, Project, SoftField, Wave } from '../../../shared/types.ts';
import { EFFECT_TARGETS, uid } from '../../../shared/types.ts';
import { DERBY_MACROS, hsvToRgb, rgbHex } from '../../../shared/color.ts';
import { type HeadKind } from '../../../shared/profiles.ts';
import { TextField } from './inputs.tsx';
import { BEAM_LABELS, BEAM_PARAMS, type BeamCaps, profileMeta } from '../profileInfo.ts';
import { hasUndrivenBeamChannels } from '../../../shared/gdtfShare.ts';
import { useStore } from '../store.ts';
import { askConfirm } from '../dialog.tsx';
import { Fader } from './Fader.tsx';

const pct = (v: number) => `${Math.round(v * 100)}%`;

const RATES: { v: number; label: string }[] = [
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

/** Fan bases in display order, with the labels the operators know. */
const DISTRIBUTE_LABELS: { v: Distribute; label: string; title: string }[] = [
  { v: 'index', label: 'idx', title: 'patch order — the classic fan' },
  { v: 'x', label: 'X', title: 'sweep stage left → right (world position)' },
  { v: 'y', label: 'Y', title: 'sweep bottom → top' },
  { v: 'z', label: 'Z', title: 'sweep upstage → downstage' },
  { v: 'radial', label: '◎', title: 'ripple out from the group centre' },
  { v: 'shuffle', label: '⤨', title: 'seeded scatter — re-roll with ↻, same seed = same look' },
  { v: 'row', label: 'row', title: 'sweep each fixture’s own pixel rows — every fixture runs the same wave' },
  { v: 'col', label: 'col', title: 'sweep each fixture’s own pixel columns — every fixture runs the same wave' },
];

const SWATCHES: { h: number; s: number }[] = [
  { h: 0, s: 1 }, { h: 30, s: 1 }, { h: 52, s: 1 }, { h: 120, s: 1 },
  { h: 160, s: 0.95 }, { h: 195, s: 1 }, { h: 228, s: 1 }, { h: 262, s: 1 },
  { h: 290, s: 1 }, { h: 315, s: 1 }, { h: 345, s: 0.9 }, { h: 0, s: 0 },
];

function groupKinds(project: Project, groupId: string): Set<HeadKind> {
  const kinds = new Set<HeadKind>();
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return kinds;
  for (const ref of group.heads) {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const head = fixture ? profileMeta(project, fixture.profileId)?.heads[ref.head] : null;
    if (head) kinds.add(head.kind);
  }
  return kinds;
}

/** Can anything in this group actually move?
 *
 *  NOT the same question as "is a head kind 'mover'". A head kind describes what
 *  one emitter is, and a fixture can be a moving head whose emitters are pixels:
 *  a Robin Spiider is exactly that, and its compiled profile is two `rgb` heads
 *  with a Pan channel wired to `source: "pan"`. Gating the pan/tilt controls on
 *  the head kind hid them on a fixture that plainly has them, while the patch
 *  table — which asks this question of the CHANNELS — showed the aim fields
 *  perfectly. This is that same test. */
function groupCanAim(project: Project, groupId: string): boolean {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.heads.some((ref) => {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    return !!meta?.hasPan || !!meta?.hasTilt;
  });
}

/** Which beam parameters any fixture in this group can actually take.
 *
 *  Same test as groupCanAim and for the same reason: ask the CHANNELS, not the
 *  head kind. A fixture only gets a zoom fader if something in the group has a
 *  zoom channel — an editor full of controls that go nowhere is worse than one
 *  that is honest about the rig. */
/** Does anything in this group drive a white emitter? A derby's white ring is
 *  a different thing — on/off hardware, already offered as `ring blinder` — so
 *  this asks for a real, faded White channel, which every RGBW wash imported
 *  from GDTF has and which the editor never offered a way to set. The parameter
 *  itself already existed and already reaches the channel in both engines; only
 *  the control was missing, so a white wash could be made by an EFFECT
 *  targeting white but not by the look itself. */
function groupCanWhite(project: Project, groupId: string): boolean {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.heads.some((ref) => {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    return !!meta?.hasWhite;
  });
}

/** Does anything in this group have beam channels with no function behind
 *  them? Distinguishes "this fixture has no zoom" from "this fixture has a zoom
 *  channel that the stored profile never wired up", which look identical in an
 *  editor that only shows what it can drive. */
function groupHasDeadBeamChannels(project: Project, groupId: string): boolean {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.heads.some((ref) => {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const compiled = fixture ? project.profiles?.[fixture.profileId] : undefined;
    return !!compiled && hasUndrivenBeamChannels(compiled);
  });
}

function groupBeamCaps(project: Project, groupId: string): BeamCaps {
  const out: BeamCaps = { zoom: false, focus: false, iris: false, frost: false, cto: false };
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return out;
  for (const ref of group.heads) {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    if (!meta) continue;
    for (const k of BEAM_PARAMS) if (meta.beam[k]) out[k] = true;
  }
  return out;
}

function Enable({ on, toggle }: { on: boolean; toggle: () => void }) {
  return <div className={`enable ${on ? 'on' : ''}`} onClick={toggle} />;
}

/** Small integer editor that commits on blur/Enter — the same discipline as
 *  BeatsInput below: clamping per keystroke makes a controlled field
 *  unclearable and floods a project write (plus an undo entry) per keypress. */
function IntInput({ value, min, max, width = 44, title, onCommit }: {
  value: number;
  min: number;
  max: number;
  width?: number;
  title?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const ref = React.useRef<HTMLInputElement>(null);
  // never clobber a draft mid-edit — a project echo must not erase typing
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Math.floor(Number(draft));
    const clean = Number.isFinite(v) ? Math.min(Math.max(min, v), max) : value;
    setDraft(String(clean));
    if (clean !== value) onCommit(clean);
  };
  return (
    <input
      ref={ref}
      className="num"
      type="number"
      min={min}
      max={max}
      style={{ width }}
      title={title}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function EffectRow({ fx, kinds, canAim, beamCaps, onEdit, onRemove, onSaveToPool, onField, soft }: {
  fx: Effect;
  kinds: Set<HeadKind>;
  canAim: boolean;
  beamCaps: BeamCaps;
  onEdit: (fn: (e: Effect) => void) => void;
  onRemove: () => void;
  onSaveToPool: () => void;
  /** P1 router: numeric knobs go through here (ride mode sends soft) */
  onField: (field: SoftField, v: number, fallback: (e: Effect) => void) => void;
  /** live soft value for one of this effect's fields, if ridden */
  soft: (field: SoftField) => number | undefined;
}) {
  // Which targets the rig in this group can actually take.
  const capable: EffectTarget[] = ['dimmer'];
  if (kinds.has('rgb') || kinds.has('derby') || kinds.has('mover')) capable.push('hue', 'strobe');
  if (kinds.has('derby')) capable.push('white');
  if (canAim) capable.push('pan', 'tilt');
  for (const k of BEAM_PARAMS) if (beamCaps[k]) capable.push(k);
  // inform, don't forbid: every target stays assignable (an effect is
  // interchangeable across groups), the ones this group can't take are just
  // grouped apart and the current target is flagged if it lands there.
  const capableSet = new Set(capable);
  const others = [...EFFECT_TARGETS].filter((t) => !capableSet.has(t));
  const targetInactive = !capableSet.has(fx.target);

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
      <select className="sel" value={fx.target} onChange={(e) => onEdit((x) => (x.target = e.target.value as EffectTarget))}>
        <optgroup label="drives this group">
          {capable.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </optgroup>
        {others.length > 0 && (
          <optgroup label="no fixtures here (still assignable)">
            {others.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </optgroup>
        )}
      </select>
      {targetInactive && (
        <span className="label" title="nothing in this group takes this parameter — it does nothing here until the effect is retargeted or dropped on a group that has it" style={{ color: 'var(--amber, #f0a63e)' }}>
          ⚠
        </span>
      )}
      <select className="sel" value={fx.wave} onChange={(e) => onEdit((x) => (x.wave = e.target.value as Wave))}>
        {WAVES.map((w) => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>
      <select
        className="sel"
        value={String(soft('rate') ?? fx.rate)}
        onChange={(e) => onField('rate', Number(e.target.value), (x) => (x.rate = Number(e.target.value)))}
      >
        {RATES.map((r) => (
          <option key={r.v} value={String(r.v)}>{r.label}</option>
        ))}
      </select>
      <Fader label="size" width={90} value={soft('size') ?? fx.size} def={1} onChange={(v) => onField('size', v, (x) => (x.size = v))} fmt={pct} variant="dim" />
      <Fader label="spread" width={90} value={soft('spread') ?? fx.spread} def={0} onChange={(v) => onField('spread', v, (x) => (x.spread = v))} fmt={pct} variant="dim" />
      {(fx.wave === 'square' || fx.wave === 'chase') && (
        <Fader label="width" width={90} value={soft('width') ?? fx.width} def={0.5} onChange={(v) => onField('width', v, (x) => (x.width = v))} fmt={pct} variant="dim" />
      )}
      <Fader label="phase" width={80} value={soft('phase') ?? fx.phase} def={0} onChange={(v) => onField('phase', v, (x) => (x.phase = v))} fmt={pct} variant="dim" />
      {/* wet/dry: how much of the effect lands. 100% is full effect. */}
      <Fader label="mix" width={80} value={soft('mix') ?? fx.mix} def={1} onChange={(v) => onField('mix', v, (x) => (x.mix = v))} fmt={pct} variant="dim" />
      <button className="btn small ghost" title="save this effect to the FX pool as a reusable preset" onClick={onSaveToPool}>☆</button>
      <button title="remove this step from the cue list" className="btn small ghost" onClick={onRemove}>✕</button>
    </div>
    <div className="fxrow" style={{ ...(fx.bypass ? { opacity: 0.5 } : {}), paddingLeft: 34 }}>
      <span className="label">fan</span>
      <div className="seg">
        {DISTRIBUTE_LABELS.map((d) => (
          <button
            key={d.v}
            className={fx.distribute === d.v ? 'on' : ''}
            title={d.title}
            onClick={() => onEdit((x) => (x.distribute = d.v))}
          >
            {d.label}
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
        title="run the fan backwards"
        onClick={() => onEdit((x) => (x.reverse = !x.reverse))}
      >
        ⇄
      </button>
      <span className="label">parts</span>
      <IntInput
        value={fx.parts}
        min={1}
        max={64}
        title="tile the fan into k repeats across the group"
        onCommit={(v) => onEdit((x) => (x.parts = v))}
      />
      <span className="label">buddy</span>
      <IntInput
        value={fx.buddy}
        min={1}
        max={64}
        title="clump size — adjacent heads share a phase"
        onCommit={(v) => onEdit((x) => (x.buddy = v))}
      />
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
    </>
  );
}

function PartEditor({ lookId, part, ride }: { lookId: string; part: LookPart; ride: boolean }) {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const softLive = useStore((s) => s.snap?.soft);
  const kinds = groupKinds(project, part.groupId);
  const canAim = groupCanAim(project, part.groupId);
  const beamCaps = groupBeamCaps(project, part.groupId);
  // a derby's ring is on/off hardware and has its own control; this is the
  // faded white emitter on an RGBW head
  const canWhite = !kinds.has('derby') && groupCanWhite(project, part.groupId);

  const edit = (fn: (pt: LookPart) => void) =>
    mutate((p) => {
      const pt = p.looks[lookId]?.parts.find((x) => x.id === part.id);
      if (pt) fn(pt);
    });

  /** P1: the live soft value for one address, if the operator is riding it. */
  const softFor = (field: SoftField, effectId?: string): number | undefined =>
    softLive?.find(
      (e) => e.lookId === lookId && e.partId === part.id && e.effectId === effectId && e.field === field,
    )?.value;

  /** Route a numeric edit. Soft when RIDE is armed — or when a soft value
   *  ALREADY exists for the address: a ridden control stays live until Store
   *  or Discard, otherwise the fader would display the soft value while
   *  silently rewriting the stored show underneath it. A brief window after
   *  ALL STOP disarms ride drops events entirely, so an in-flight drag can
   *  neither re-create the rides the panic cleared nor mutate the show. */
  const rideCutAt = useStore((s) => s.rideCutAt);
  const setP = (field: SoftField, v: number, fallback: (pt: LookPart) => void): void => {
    if (Date.now() - rideCutAt < 800) return;
    if (ride || softFor(field) !== undefined) send({ type: 'soft', lookId, partId: part.id, field, value: v });
    else edit(fallback);
  };
  const setE = (effectId: string, field: SoftField, v: number, fallback: (e: Effect) => void): void => {
    if (Date.now() - rideCutAt < 800) return;
    if (ride || softFor(field, effectId) !== undefined) send({ type: 'soft', lookId, partId: part.id, effectId, field, value: v });
    else
      edit((pt) => {
        const e = pt.effects.find((x) => x.id === effectId);
        if (e) fallback(e);
      });
  };

  const prm = part.params;
  const hasColorTargets = kinds.has('rgb') || kinds.has('derby') || kinds.has('mover');

  return (
    <div>
      <div className="parthead">
        <span className="label">group</span>
        <select
          className="sel"
          value={part.groupId}
          onChange={(e) => edit((pt) => (pt.groupId = e.target.value))}
        >
          {project.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <div className="grow" />
        <button
          className="btn small ghost"
          onClick={() => mutate((p) => {
            const look = p.looks[lookId];
            if (look) look.parts = look.parts.filter((x) => x.id !== part.id);
          })}
        
            title="remove this part from the look — the fixture group itself is untouched">
          remove part
        </button>
      </div>
      <div className="partbody">
        {kinds.size > 0 && !(kinds.size === 1 && kinds.has('hazer')) && (
          <div className="paramrow">
            <Enable on={prm.dimmer !== undefined} toggle={() => edit((pt) => (pt.params.dimmer = pt.params.dimmer === undefined ? 1 : undefined))} />
            <span className="label">dimmer</span>
            <div className={`grow paramrow ${prm.dimmer === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
              <Fader value={softFor('dimmer') ?? prm.dimmer ?? 1} def={1} onChange={(v) => setP('dimmer', v, (pt) => (pt.params.dimmer = v))} fmt={pct} width="100%" />
            </div>
          </div>
        )}

        {canWhite && (
            <div className="paramrow">
              <Enable
                on={prm.white !== undefined}
                toggle={() => edit((pt) => (pt.params.white = pt.params.white === undefined ? 1 : undefined))}
              />
              <span className="label">white</span>
              <div className={`grow paramrow ${prm.white === undefined ? 'off' : ''}`}>
                <Fader
                  label="white"
                  width={180}
                  value={softFor('white') ?? prm.white ?? 1}
                  def={1}
                  onChange={(v) => setP('white', v, (pt) => (pt.params.white = v))}
                  fmt={pct}
                  variant="dim"
                />
              </div>
            </div>
        )}
        {hasColorTargets && (
          <div className="paramrow">
            <Enable on={!!prm.color} toggle={() => edit((pt) => (pt.params.color = pt.params.color ? undefined : { h: 0, s: 1 }))} />
            <span className="label">colour</span>
            <div className={`grow paramrow ${prm.color ? '' : 'off'}`} style={{ gap: 8 }}>
              <Fader
                variant="hue"
                width="38%"
                min={0}
                max={360}
                value={softFor('hue') ?? prm.color?.h ?? 0}
                onChange={(v) => setP('hue', v, (pt) => (pt.params.color = { h: v, s: pt.params.color?.s ?? 1 }))}
                fmt={(v) => `${Math.round(v)}°`}
                label=""
              />
              <Fader
                label="sat"
                width={90}
                value={softFor('sat') ?? prm.color?.s ?? 1}
                def={1}
                onChange={(v) => setP('sat', v, (pt) => (pt.params.color = { h: pt.params.color?.h ?? 0, s: v }))}
                fmt={pct}
                variant="dim"
              />
              <div className="swatches">
                {SWATCHES.map((sw, i) => {
                  const [r, g, b] = hsvToRgb(sw.h, sw.s, 1);
                  return (
                    <i
                      key={i}
                      style={{ background: rgbHex(r, g, b) }}
                      onClick={() => {
                        // a swatch IS a hue+sat pair: with ride armed or the
                        // colour already ridden it must go through the soft
                        // layer, or the click looks dead (soft wins on the
                        // rig) while silently rewriting the stored show
                        if (ride || softFor('hue') !== undefined || softFor('sat') !== undefined) {
                          send({ type: 'soft', lookId, partId: part.id, field: 'hue', value: sw.h });
                          send({ type: 'soft', lookId, partId: part.id, field: 'sat', value: sw.s });
                        } else edit((pt) => (pt.params.color = { ...sw }));
                      }}
                    />
                  );
                })}
              </div>
              <i
                style={{ width: 20, height: 20, borderRadius: 3, border: '1px solid var(--line2)', flexShrink: 0,
                  background: prm.color ? rgbHex(...hsvToRgb(prm.color.h, prm.color.s, 1)) : '#333' }}
              />
            </div>
          </div>
        )}

        {kinds.has('derby') && (
          <>
            <div className="paramrow">
              <span className="label" style={{ marginLeft: 20 }}>derby macro</span>
              <select
                className="sel"
                value={prm.macro === undefined ? 'auto' : String(prm.macro)}
                onChange={(e) => edit((pt) => (pt.params.macro = e.target.value === 'auto' ? undefined : Number(e.target.value)))}
              >
                <option value="auto">auto — nearest to colour</option>
                {DERBY_MACROS.filter((m) => m.value > 0).map((m) => (
                  <option key={m.value} value={String(m.value)}>{m.name}</option>
                ))}
              </select>
              <button
                className={`btn small ${prm.white !== undefined ? 'on' : ''}`}
                onClick={() => edit((pt) => (pt.params.white = pt.params.white === undefined ? 1 : undefined))}
                title="white LED ring full-on (blinder)"
              >
                ring blinder
              </button>
            </div>
            <div className="paramrow">
              <Enable on={prm.ringFx !== undefined} toggle={() => edit((pt) => (pt.params.ringFx = pt.params.ringFx === undefined ? 0.5 : undefined))} />
              <span className="label">ring fx</span>
              <div className={`grow paramrow ${prm.ringFx === undefined ? 'off' : ''}`}>
                <Fader value={softFor('ringFx') ?? prm.ringFx ?? 0.5} onChange={(v) => setP('ringFx', v, (pt) => (pt.params.ringFx = v))} fmt={pct} width={180} variant="dim" />
              </div>
            </div>
            <div className="paramrow">
              <Enable on={prm.motorMode !== undefined} toggle={() => edit((pt) => {
                if (pt.params.motorMode === undefined) {
                  pt.params.motorMode = 'rotate';
                  pt.params.motorValue = 0.3;
                } else {
                  pt.params.motorMode = undefined;
                  pt.params.motorValue = undefined;
                }
              })} />
              <span className="label">motor</span>
              <div className={`grow paramrow ${prm.motorMode === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
                <div className="seg">
                  {(['off', 'aim', 'rotate'] as const).map((m) => (
                    <button
                      key={m}
                      className={prm.motorMode === m ? 'on' : ''}
                      title={
                        m === 'off'
                          ? 'motor parked'
                          : m === 'aim'
                            ? 'hold a fixed position — the fader below picks it'
                            : 'spin continuously — the fader below is speed, not position'
                      }
                      onClick={() => edit((pt) => (pt.params.motorMode = m))}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <Fader
                  label={prm.motorMode === 'aim' ? 'position' : 'speed'}
                  width={160}
                  value={softFor('motorValue') ?? prm.motorValue ?? 0.3}
                  onChange={(v) => setP('motorValue', v, (pt) => (pt.params.motorValue = v))}
                  fmt={pct}
                  variant="dim"
                />
              </div>
            </div>
          </>
        )}

        {hasColorTargets && (
          <div className="paramrow">
            <Enable on={prm.strobe !== undefined} toggle={() => edit((pt) => (pt.params.strobe = pt.params.strobe === undefined ? 0.6 : undefined))} />
            <span className="label">strobe</span>
            <div className={`grow paramrow ${prm.strobe === undefined ? 'off' : ''}`}>
              <Fader value={softFor('strobe') ?? prm.strobe ?? 0.6} onChange={(v) => setP('strobe', v, (pt) => (pt.params.strobe = v))} fmt={pct} width={180} variant="dim" />
            </div>
          </div>
        )}

        {canAim && (
          <div className="paramrow">
            <Enable on={prm.pan !== undefined || prm.tilt !== undefined} toggle={() => edit((pt) => {
              if (pt.params.pan === undefined) {
                pt.params.pan = 0.5;
                pt.params.tilt = 0.5;
              } else {
                pt.params.pan = undefined;
                pt.params.tilt = undefined;
              }
            })} />
            <span className="label">position</span>
            <div className={`grow paramrow ${prm.pan === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
              <Fader label="pan" width={140} value={softFor('pan') ?? prm.pan ?? 0.5} def={0.5} onChange={(v) => setP('pan', v, (pt) => (pt.params.pan = v))} fmt={pct} variant="dim" />
              <Fader label="tilt" width={140} value={softFor('tilt') ?? prm.tilt ?? 0.5} def={0.5} onChange={(v) => setP('tilt', v, (pt) => (pt.params.tilt = v))} fmt={pct} variant="dim" />
            </div>
          </div>
        )}

        {/* Nothing in the group takes a beam parameter, but something in it
            HAS beam channels that are simply not driven — the profile came from
            a thin GDTF or an older importer. Without this the editor just looks
            like it forgot zoom, which is exactly how it was reported. */}
        {BEAM_PARAMS.every((k) => !beamCaps[k]) && groupHasDeadBeamChannels(project, part.groupId) && (
          <div className="row">
            <span className="label" style={{ color: 'var(--warn)' }}>⚠</span>
            <span className="label" style={{ whiteSpace: 'normal', lineHeight: 1.5 }}>
              this group's fixtures list zoom/focus/iris/frost/cto channels that their
              profile does not drive — re-import their GDTF in the Fixtures tab to get
              the controls
            </span>
          </div>
        )}
        {BEAM_PARAMS.filter((k) => beamCaps[k]).map((k) => (
          <div className="paramrow" key={k}>
            <Enable
              on={prm[k] !== undefined}
              toggle={() => edit((pt) => (pt.params[k] = pt.params[k] === undefined ? 0.5 : undefined))}
            />
            <span className="label">{BEAM_LABELS[k]}</span>
            <div className={`grow paramrow ${prm[k] === undefined ? 'off' : ''}`}>
              <Fader
                value={softFor(k) ?? prm[k] ?? 0.5}
                def={0.5}
                onChange={(v) => setP(k, v, (pt) => (pt.params[k] = v))}
                fmt={pct}
                width={180}
                variant="dim"
              />
            </div>
          </div>
        ))}

        {kinds.has('hazer') && (
          <div className="paramrow">
            <Enable on={prm.haze !== undefined} toggle={() => edit((pt) => {
              if (pt.params.haze === undefined) {
                pt.params.haze = 0.5;
                pt.params.fan = 0.35;
              } else {
                pt.params.haze = undefined;
                pt.params.fan = undefined;
              }
            })} />
            <span className="label">haze</span>
            <div className={`grow paramrow ${prm.haze === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
              <Fader label="output" width={140} value={softFor('haze') ?? prm.haze ?? 0.5} onChange={(v) => setP('haze', v, (pt) => (pt.params.haze = v))} fmt={pct} variant="dim" />
              <Fader label="fan" width={140} value={softFor('fan') ?? prm.fan ?? 0.35} onChange={(v) => setP('fan', v, (pt) => (pt.params.fan = v))} fmt={pct} variant="dim" />
            </div>
          </div>
        )}

        {part.effects.map((fx) => (
          <EffectRow
            key={fx.id}
            fx={fx}
            kinds={kinds}
            canAim={canAim}
            beamCaps={beamCaps}
            onEdit={(fn) => edit((pt) => {
              const e = pt.effects.find((x) => x.id === fx.id);
              if (e) fn(e);
            })}
            onRemove={() => edit((pt) => (pt.effects = pt.effects.filter((x) => x.id !== fx.id)))}
            onField={(field, v, fallback) => setE(fx.id, field, v, fallback)}
            soft={(field) => softFor(field, fx.id)}
            onSaveToPool={() => mutate((p) => {
              // copy-on-apply's mirror: snapshot the effect into the pool, so a
              // later edit to this look never rewrites the stored preset.
              const preset = { id: uid('fp'), name: `${fx.target} ${fx.wave}`, effect: { ...fx } };
              p.fxPool = [...(p.fxPool ?? []), preset];
            })}
          />
        ))}
        <div className="row">
          <button
            className="btn small ghost"
            onClick={() => edit((pt) => pt.effects.push({ id: uid('fx'), target: 'dimmer', wave: 'sine', rate: 4, size: 1, spread: 0, width: 0.5, phase: 0, bypass: false, mix: 1, distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0 }))}
          
            title="add an effect to this part: a wave over one parameter, locked to the beat">
            + effect
          </button>
          {(project.fxPool?.length ?? 0) > 0 && (
            <select
              className="sel"
              value=""
              title="drop a saved preset onto this group (copied in — editing it later never changes the pool)"
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const preset = project.fxPool?.find((fp) => fp.id === id);
                // copy-on-apply: a fresh id so the running look owns its copy
                if (preset) edit((pt) => pt.effects.push({ ...preset.effect, id: uid('fx') }));
              }}
            >
              <option value="">apply from pool…</option>
              {(project.fxPool ?? []).map((fp) => (
                <option key={fp.id} value={fp.id}>{fp.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

/** Beats editor that commits on blur/Enter — per-keystroke clamping made
 *  fractional values untypeable ("0.5" clamped at "0") and the field
 *  unclearable. */
function BeatsInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const ref = React.useRef<HTMLInputElement>(null);
  // never clobber a draft mid-edit — a project echo must not erase what is
  // being typed; blur re-syncs (same guard as the other live-routing inputs)
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Number(draft);
    const clean = Number.isFinite(v) && v > 0 ? Math.min(v, 512) : 1;
    setDraft(String(clean));
    if (clean !== value) onCommit(clean);
  };
  return (
    <input
      ref={ref}
      className="num"
      type="number"
      min={0.25}
      step={0.25}
      style={{ width: 60 }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function LookEditor() {
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const ride = useStore((s) => s.ride);
  const setRide = useStore((s) => s.setRide);

  if (!sel) return <div className="hint">Select a cell in the grid to edit its look — click an empty cell to start a new one (it won't fire the layer).</div>;

  const layer = project.layers.find((l) => l.id === sel.layerId);
  if (!layer) return <div className="hint">Layer no longer exists.</div>;
  const lookId = layer.cells[sel.col] ?? null;
  // hasOwn, not a bare index: a cell id of "constructor"/"toString" resolves to
  // a function off Object's prototype (truthy), and look.parts.map below then
  // throws and takes down the whole bottom-panel Region. The grid, previz and
  // swatch code all guard this way — this reader was the one that didn't.
  const look: Look | null =
    lookId && Object.hasOwn(project.looks, lookId) ? project.looks[lookId] : null;

  if (!look || !lookId) {
    // Looks are a shared pool across decks, so filling a cell from the pool is
    // the primary authoring move — without it a new deck is 32 dead cells.
    const pool = Object.values(project.looks).sort((a, b) => a.name.localeCompare(b.name));
    return (
      <div className="hint">
        <div style={{ marginBottom: 10 }}>
          Empty cell — {layer.name} · column {sel.col + 1}
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              mutate((p) => {
                const id = uid('look');
                p.looks[id] = {
                  id,
                  name: 'New look',
                  parts: [{ id: uid('part'), groupId: p.groups[0]?.id ?? '', params: { dimmer: 1 }, effects: [] }],
                };
                const ly = p.layers.find((l) => l.id === sel.layerId);
                if (ly) ly.cells[sel.col] = id;
              })
            }
          
            title="make a new look on this pad and open it for editing — nothing fires">
            + create look here
          </button>
          <select
            className="sel"
            value=""
            disabled={pool.length === 0}
            title="put an existing look from the pool into this cell"
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              mutate((p) => {
                const ly = p.layers.find((l) => l.id === sel.layerId);
                if (ly) ly.cells[sel.col] = id;
              });
            }}
          >
            <option value="">use existing look…</option>
            {pool.map((l) => (
              <option key={l.id} value={l.id}>
                {l.steps?.length ? '⛓ ' : ''}{l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="label" style={{ marginTop: 8 }}>
          {pool.length} look{pool.length === 1 ? '' : 's'} in this project’s pool — the same look can sit in
          many cells and decks.
        </div>
      </div>
    );
  }

  const editLook = (fn: (lk: Look) => void) =>
    mutate((p) => {
      const lk = p.looks[lookId];
      if (lk) fn(lk);
    });

  return (
    <div className="lookeditor">
      <div className="row">
        <span className="chip">{layer.name} · {sel.col + 1}</span>
        <TextField
          className="text"
          style={{ width: 220, fontSize: 13 }}
          entityId={look.id}
          value={look.name}
          onCommit={(v) => editLook((lk) => (lk.name = v))}
        />
        <button
          className={`btn small ${look.flash ? 'on' : ''}`}
          title="momentary — active only while held"
          onClick={() => editLook((lk) => (lk.flash = !lk.flash || undefined))}
        >
          flash
        </button>
        <span className="label">fade</span>
        <input
          className="num"
          type="number"
          step="0.1"
          min="0"
          placeholder={String(layer.fade)}
          value={look.fade ?? ''}
          onChange={(e) => editLook((lk) => (lk.fade = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value))))}
        />
        <span className="label">s</span>
        <button className="btn small ghost" onClick={() => send({ type: 'trigger', layerId: layer.id, col: sel.col })}
            title="fire this look on its layer now, exactly as clicking the pad would">
          ▶ fire
        </button>
        <button
          className={`btn small ${ride ? 'on' : 'ghost'}`}
          title="RIDE: fader moves become live soft overrides (~40 bytes, no project write, no undo spam) — Store writes them into the look, Discard drops them. Cleared by ALL STOP and project switch."
          onClick={() => setRide(!ride)}
          style={ride ? { background: 'var(--amber, #f0a63e)', color: '#000' } : undefined}
        >
          ride
        </button>
        <select
          className="sel"
          value={lookId}
          title="swap this cell for another look from the pool"
          onChange={(e) => {
            const id = e.target.value;
            if (!id || id === lookId) return;
            mutate((p) => {
              const ly = p.layers.find((l) => l.id === sel.layerId);
              if (ly) ly.cells[sel.col] = id;
            });
          }}
        >
          {Object.values(project.looks)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.steps?.length ? '⛓ ' : ''}{l.name}
              </option>
            ))}
        </select>
        <div className="grow" />
        <button
          className="btn small ghost"
          onClick={() => mutate((p) => {
            const ly = p.layers.find((l) => l.id === sel.layerId);
            if (ly) ly.cells[sel.col] = null;
          })}
        
            title="empty this pad. The look stays in the library and on any other pad using it.">
          clear cell
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            void (async () => {
              const refs = Object.values(project.looks).filter(
                (l) => l.steps?.some((st) => st.lookId === lookId),
              );
              // the look lives in ONE pool shared by every song — deleting it
              // blanks its cell in each of them, which was silent before
              const decksHit = (project.decks ?? []).filter((d) =>
                Object.values(d.cells).some((cells) => cells.includes(lookId)),
              );
              const cellCount = (project.decks ?? []).reduce(
                (n, d) =>
                  n + Object.values(d.cells).reduce((m, cells) => m + cells.filter((c) => c === lookId).length, 0),
                0,
              );
              // The CURRENT song's cells live in project.layers, not in the
              // deck's stored copy — that only syncs on a deck switch. A look
              // placed in this song since the last switch was invisible to the
              // scan above, so deleting it emptied cells with no warning at all.
              const liveCells = project.layers.reduce(
                (n, ly) => n + ly.cells.filter((c) => c === lookId).length,
                0,
              );
              if (refs.length > 0 || decksHit.length > 0 || liveCells > 0) {
                const parts: string[] = [];
                if (liveCells > 0) {
                  parts.push(
                    `It is in ${liveCells} cell(s) of the song you are on. Those cells will be emptied.`,
                  );
                }
                if (decksHit.length > 0) {
                  parts.push(
                    `It is used in ${cellCount} cell(s) across ${decksHit.length} song(s): ${decksHit
                      .map((d) => d.name)
                      .join(', ')}. Those cells will be emptied.`,
                  );
                }
                if (refs.length > 0) {
                  parts.push(
                    `It is a step in ${refs.length} cue list(s): ${refs.map((l) => l.name).join(', ')}. Those steps will go dark.`,
                  );
                }
                const ok = await askConfirm(`Delete "${look.name}"?`, {
                  body: parts.join('\n\n'),
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!ok) return;
              }
              mutate((p) => {
                delete p.looks[lookId];
                for (const ly of p.layers) ly.cells = ly.cells.map((c) => (c === lookId ? null : c));
                // stored decks hold their own copies of the cells
                for (const d of p.decks ?? []) {
                  for (const [lid, cells] of Object.entries(d.cells)) {
                    d.cells[lid] = cells.map((c) => (c === lookId ? null : c));
                  }
                }
              });
            })();
          }}
        
            title="delete the look from the library and from every pad in every song that uses it">
          delete look
        </button>
      </div>

      {look.steps?.length ? (
        <div>
          <div className="sectionhead" style={{ marginTop: 10 }}>
            Cue steps — hard cuts on the beat, loops, starts at step 1 when fired
          </div>
          {look.steps.map((st, i) => (
            <div className="row" key={i} style={{ marginBottom: 4 }}>
              <span className="chip">{i + 1}</span>
              <select
                className="sel"
                value={st.lookId}
                onChange={(e) => editLook((lk) => { if (lk.steps?.[i]) lk.steps[i].lookId = e.target.value; })}
              >
                {(() => {
                  // hasOwn: a prototype-key step id must read as "missing", not
                  // resolve to Object.prototype and mislabel itself
                  const stepLook = Object.hasOwn(project.looks, st.lookId) ? project.looks[st.lookId] : undefined;
                  return !stepLook || stepLook.steps?.length ? (
                    <option value={st.lookId}>
                      {stepLook ? '(cue list - renders dark)' : '(missing look)'}
                    </option>
                  ) : null;
                })()}
                {Object.values(project.looks)
                  .filter((l) => !l.steps?.length)
                  .map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
              </select>
              <BeatsInput
                value={st.beats}
                onCommit={(v) => editLook((lk) => { if (lk.steps?.[i]) lk.steps[i].beats = v; })}
              />
              <span className="label">beats</span>
              <button
                title="move this effect later — order matters, they stack in sequence"
                className="btn small ghost"
                disabled={i === 0}
                onClick={() => editLook((lk) => {
                  if (!lk.steps || i === 0) return;
                  [lk.steps[i - 1], lk.steps[i]] = [lk.steps[i], lk.steps[i - 1]];
                })}
              >
                ↑
              </button>
              <button
                title="remove this effect from the part"
                className="btn small ghost"
                disabled={i === (look.steps?.length ?? 0) - 1}
                onClick={() => editLook((lk) => {
                  if (!lk.steps || i >= lk.steps.length - 1) return;
                  [lk.steps[i], lk.steps[i + 1]] = [lk.steps[i + 1], lk.steps[i]];
                })}
              >
                ↓
              </button>
              <button
                className="btn small ghost"
                title="remove this step from the cue list"
                onClick={() => editLook((lk) => {
                  lk.steps?.splice(i, 1);
                  if (lk.steps?.length === 0) delete lk.steps;
                })}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="row">
            <button
              className="btn small ghost"
              disabled={!Object.values(project.looks).some((l) => !l.steps?.length && l.id !== lookId)}
              title="add a step (needs at least one plain look)"
              onClick={() => editLook((lk) => {
                const first = Object.values(project.looks).find((l) => !l.steps?.length && l.id !== lookId);
                if (first) lk.steps?.push({ lookId: first.id, beats: 1 });
              })}
            >
              + step
            </button>
            <button
              className="btn small ghost"
              title="remove all steps — the look becomes a plain look again"
              onClick={() => editLook((lk) => { delete lk.steps; })}
            >
              → plain look
            </button>
          </div>
        </div>
      ) : (
        <>
          {look.parts.map((part) => (
            <PartEditor key={part.id} lookId={lookId} part={part} ride={ride} />
          ))}

          <div className="row">
            <button
              className="btn small ghost"
              onClick={() => editLook((lk) => lk.parts.push({ id: uid('part'), groupId: project.groups[0]?.id ?? '', params: { dimmer: 1 }, effects: [] }))}
            
            title="add another fixture group to this look, with its own colour, position and effects">
              + part (fixture group)
            </button>
            {(() => {
              const referencedBy = Object.values(project.looks).filter(
                (l) => l.steps?.some((st) => st.lookId === lookId),
              ).length;
              const eligible = Object.values(project.looks).some(
                (l) => !l.steps?.length && l.id !== lookId,
              );
              return (
                <button
                  className="btn small ghost"
                  disabled={referencedBy > 0 || !eligible}
                  title={
                    referencedBy > 0
                      ? `used as a step by ${referencedBy} cue list(s) - cue lists cannot nest`
                      : eligible
                        ? 'turn this look into a cue list that steps through other looks on the beat'
                        : 'needs at least one other plain look to step through'
                  }
                  onClick={() => editLook((lk) => {
                    const first = Object.values(project.looks).find((l) => !l.steps?.length && l.id !== lookId);
                    if (first) lk.steps = [{ lookId: first.id, beats: 1 }];
                  })}
                >
                  ⛓ cue list
                </button>
              );
            })()}
          </div>

          {(project.fxPool?.length ?? 0) > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="sectionhead">FX pool — reusable presets ({project.fxPool!.length})</div>
              <div className="label" style={{ marginBottom: 6 }}>
                Copies in on “apply from pool”, so editing a look never rewrites the preset — and editing the preset never changes a look already using it.
              </div>
              {project.fxPool!.map((fp) => (
                <div className="row" key={fp.id} style={{ marginBottom: 4 }}>
                  <TextField
                    className="text"
                    style={{ width: 180, fontSize: 13 }}
                    entityId={fp.id}
                    value={fp.name}
                    onCommit={(v) => mutate((p) => {
                      const e = p.fxPool?.find((x) => x.id === fp.id);
                      if (e) e.name = v;
                    })}
                  />
                  <span className="label">{fp.effect.target} · {fp.effect.wave}</span>
                  <div className="grow" />
                  <button
                    className="btn small ghost"
                    title="remove this preset from the pool (looks that already used it keep their copy)"
                    onClick={() => mutate((p) => {
                      p.fxPool = (p.fxPool ?? []).filter((x) => x.id !== fp.id);
                      if (p.fxPool.length === 0) delete p.fxPool;
                    })}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
