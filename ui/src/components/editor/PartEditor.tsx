// One part of a look: the fixture group it drives, and what it does to them.
//
// The controls are grouped into the five families the desk names — Intensity ·
// Colour · Position · Beam · Haze — and one is shown at a time, because a
// mover with optics puts thirty controls on a pane that is 306 px tall on the
// Tauri floor. Only the families the group can actually take are offered, each
// with a dot when the look sets anything there, amber when a nudge is riding
// it: what is folded away still says it is there.

import React, { useState } from 'react';
import type { Effect, LookPart, SoftField, StrobeMode } from '../../../../shared/types.ts';
import { uid } from '../../../../shared/types.ts';
import { DERBY_MACROS, hsvToRgb, rgbHex } from '../../../../shared/color.ts';
import { BEAM_FADERS, BEAM_LABELS, BEAM_PARAMS, type BeamParam, fmtStrobe } from '../../profileInfo.ts';
import { Fader, fmtPct } from '../Fader.tsx';
import { ColourWheel } from '../ColourWheel.tsx';
import { FxPicker } from '../FxPicker.tsx';
import type { FxFactoryPreset } from '../../fxLibrary.ts';
import { DialMenu, Enable, SlotRow } from './fields.tsx';
import { EffectRow } from './EffectRow.tsx';
import { FEATURE_FIELDS, FEATURE_ORDER, FEATURE_PARAMS, capableTargets, featuresFor, groupCaps } from './groups.ts';
import { type Feature, FEATURE_LABEL, useEditorStore } from '../../editorStore.ts';
import { useStore } from '../../store.ts';

const SWATCHES: { h: number; s: number }[] = [
  { h: 0, s: 1 }, { h: 30, s: 1 }, { h: 52, s: 1 }, { h: 120, s: 1 },
  { h: 160, s: 0.95 }, { h: 195, s: 1 }, { h: 228, s: 1 }, { h: 262, s: 1 },
  { h: 290, s: 1 }, { h: 315, s: 1 }, { h: 345, s: 0.9 }, { h: 0, s: 0 },
];

export function PartEditor({ lookId, part, ride }: { lookId: string; part: LookPart; ride: boolean }) {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const softLive = useStore((s) => s.snap?.soft);
  const caps = groupCaps(project, part.groupId);
  const { kinds, canAim, canWhite, beamCaps, optics } = caps;

  // The factory catalogue's picker. It applies as you browse — the effect it
  // put there is tracked so the next pick replaces it rather than stacking a
  // dozen auditions onto the part.
  const [fxPickerOpen, setFxPickerOpen] = useState(false);
  const fxPickerBtn = React.useRef<HTMLButtonElement>(null);
  const previewFx = React.useRef<string | null>(null);
  const dropPreview = (pt: LookPart) => {
    if (previewFx.current) pt.effects = pt.effects.filter((x) => x.id !== previewFx.current);
  };
  const previewPreset = (p: FxFactoryPreset) => {
    const id = uid('fx');
    edit((pt) => {
      dropPreview(pt);
      pt.effects.push({ ...p.effect, id });
    }, `add ${p.name} effect`);
    previewFx.current = id;
  };
  const closePicker = (keep: boolean) => {
    if (!keep && previewFx.current) edit((pt) => dropPreview(pt), 'remove the previewed effect');
    previewFx.current = null;
    setFxPickerOpen(false);
  };

  const edit = (fn: (pt: LookPart) => void, label?: string) =>
    mutate((p) => {
      const pt = p.looks[lookId]?.parts.find((x) => x.id === part.id);
      if (pt) fn(pt);
    }, label);

  /** P1: the live soft value for one address, if the operator is nudging it. */
  const softFor = (field: SoftField, effectId?: string): number | undefined =>
    softLive?.find(
      (e) => e.lookId === lookId && e.partId === part.id && e.effectId === effectId && e.field === field,
    )?.value;

  /** Route a numeric edit. Soft when a nudge is armed — or when a soft value
   *  ALREADY exists for the address: a nudged control stays live until Keep
   *  or Discard, otherwise the fader would display the nudged value while
   *  silently rewriting the stored show underneath it. A brief window after
   *  ALL STOP disarms the nudge drops events entirely, so an in-flight drag can
   *  neither re-create the nudges the panic cleared nor mutate the show. */
  const rideCutAt = useStore((s) => s.rideCutAt);
  const setP = (field: SoftField, v: number, fallback: (pt: LookPart) => void): void => {
    if (Date.now() - rideCutAt < 800) return;
    if (ride || softFor(field) !== undefined) send({ type: 'soft', lookId, partId: part.id, field, value: v });
    else edit(fallback);
  };

  /** Set the part's colour, from wherever the click came from.
   *
   *  A swatch, a tint and a drag on the disc are all a hue+sat PAIR, and all
   *  three have to take the same road: with a nudge armed, or the colour
   *  already nudged, it goes through the soft layer — otherwise the click
   *  looks dead, because the nudge wins on the rig, while it quietly
   *  rewrites the stored show underneath. */
  const setColour = (h: number, sat: number): void => {
    if (ride || softFor('hue') !== undefined || softFor('sat') !== undefined) {
      send({ type: 'soft', lookId, partId: part.id, field: 'hue', value: h });
      send({ type: 'soft', lookId, partId: part.id, field: 'sat', value: sat });
    } else edit((pt) => (pt.params.color = { h, s: sat }));
  };

  const [wheel, setWheel] = useState(false);
  const colourChip = React.useRef<HTMLButtonElement>(null);

  /** One optional 0..1 parameter: enable, label, fader. Beam shaping and the
   *  two optics rotations share it. The middle is the default because on a
   *  rotate band the middle is stopped and on a zoom it is the mid throw. */
  const beamRow = (k: BeamParam, kelvin?: [number, number]) => (
    <div className="paramrow" key={k}>
      <Enable
        on={prm[k] !== undefined}
        toggle={() => edit((pt) => (pt.params[k] = pt.params[k] === undefined ? 0.5 : undefined))}
      />
      <span className="label">{BEAM_LABELS[k]}</span>
      <div className={`grow paramrow ${prm[k] === undefined ? 'off' : ''}`}>
        <Fader
          help={`${BEAM_LABELS[k]} — greyed out until the ⏻ beside it enables this parameter for the part`}
          value={softFor(k) ?? prm[k] ?? 0.5}
          def={0.5}
          onChange={(v) => setP(k, v, (pt) => (pt.params[k] = v))}
          fmt={kelvin ? (v) => `${Math.round((kelvin[0] + (kelvin[1] - kelvin[0]) * v) / 50) * 50}K` : fmtPct}
          width={180}
          variant="dim"
        />
      </div>
      <DialMenu lookId={lookId} partId={part.id} fields={[k]} />
    </div>
  );
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

  // The feature row. Which families this group can take, which one is showing,
  // and — for each — whether the look sets anything there and whether a nudge
  // is riding it.
  const families = featuresFor(caps);
  const remembered = useEditorStore((s) => s.feature[part.id]);
  const setFeature = useEditorStore((s) => s.setFeature);
  const shown: Feature | undefined = families.includes(remembered) ? remembered : families[0];
  const isSet = (f: Feature) => FEATURE_PARAMS[f].some((k) => prm[k] !== undefined);
  const isNudged = (f: Feature) => FEATURE_FIELDS[f].some((k) => softFor(k) !== undefined);

  return (
    <div>
      <div className="parthead">
        <span className="label">group</span>
        <select
          className="sel"
          title="the fixtures this part drives. Group ORDER is chase order, so it decides how a chase or an in-order spread runs through them"
          value={part.groupId}
          onChange={(e) => edit((pt) => (pt.groupId = e.target.value))}
        >
          {project.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        {!project.groups.some((g) => g.id === part.groupId) && (
          <span className="prose" style={{ color: 'var(--warn)' }}>no group — this part drives nothing until it has one</span>
        )}
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
        {families.length > 1 && (
          <div className="featurerow" role="tablist" aria-label="what this part sets">
            {FEATURE_ORDER.filter((f) => families.includes(f)).map((f) => {
              const set = isSet(f);
              const nudged = isNudged(f);
              return (
                <button
                  key={f}
                  role="tab"
                  aria-selected={shown === f}
                  className={shown === f ? 'on' : ''}
                  title={
                    nudged
                      ? `${FEATURE_LABEL[f]} — a nudge is driving it live. Keep in the top bar writes it in`
                      : set
                        ? `${FEATURE_LABEL[f]} — this look sets something here`
                        : `${FEATURE_LABEL[f]} — this look leaves it to the layers below`
                  }
                  onClick={() => setFeature(part.id, f)}
                >
                  {FEATURE_LABEL[f]}
                  {(set || nudged) && <i className={`fdot ${nudged ? 'nudged' : ''}`} />}
                </button>
              );
            })}
          </div>
        )}

        {shown === 'intensity' && (
          <>
            <div className="paramrow">
              <Enable on={prm.dimmer !== undefined} toggle={() => edit((pt) => (pt.params.dimmer = pt.params.dimmer === undefined ? 1 : undefined))} />
              <span className="label">dimmer</span>
              <div className={`grow paramrow ${prm.dimmer === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
                <Fader help="intensity for this part. Double-click to reset to full" value={softFor('dimmer') ?? prm.dimmer ?? 1} nudged={softFor('dimmer') !== undefined} def={1} onChange={(v) => setP('dimmer', v, (pt) => (pt.params.dimmer = v))} fmt={fmtPct} width="100%" />
              </div>
              <DialMenu lookId={lookId} partId={part.id} fields={['dimmer']} />
            </div>

            {hasColorTargets && (
              <div className="paramrow">
                <Enable on={prm.strobe !== undefined} toggle={() => edit((pt) => (pt.params.strobe = pt.params.strobe === undefined ? 0.6 : undefined))} />
                <span className="label">strobe</span>
                <div className={`grow paramrow ${prm.strobe === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
                  {/* A rate, not a percentage: what the fader is really setting
                      is flashes a second, and the number an operator counts on
                      the wall is the one worth showing. */}
                  <Fader help="strobe rate — flashes a second, slow at the left and fastest at the right" value={softFor('strobe') ?? prm.strobe ?? 0.6} nudged={softFor('strobe') !== undefined} onChange={(v) => setP('strobe', v, (pt) => (pt.params.strobe = v))} fmt={fmtStrobe} width={180} variant="dim" />
                  {/* the pattern, where something in the group has one: a band
                      of its own on the shutter channel. A fixture without the
                      pattern strobes plain, so this can never silence a head. */}
                  {optics.strobeModes.length > 0 && (
                    <div className="seg">
                      {(['strobe', ...optics.strobeModes] as StrobeMode[]).map((m) => (
                        <button
                          key={m}
                          className={(prm.strobeMode ?? 'strobe') === m ? 'on' : ''}
                          title={
                            m === 'strobe'
                              ? 'plain strobe — hard cuts at the set rate'
                              : m === 'pulse'
                                ? 'each flash ramps open and shut instead of cutting'
                                : 'irregular flashes around the set rate. A fixture without the pattern strobes plain'
                          }
                          onClick={() => edit((pt) => (pt.params.strobeMode = m === 'strobe' ? undefined : m))}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <DialMenu lookId={lookId} partId={part.id} fields={['strobe']} />
              </div>
            )}
          </>
        )}

        {shown === 'colour' && (
          <>
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
                    value={softFor('white') ?? prm.white ?? 1} nudged={softFor('white') !== undefined}
                    def={1}
                    onChange={(v) => setP('white', v, (pt) => (pt.params.white = v))}
                    fmt={fmtPct}
                    variant="dim"
                  />
                </div>
                <DialMenu lookId={lookId} partId={part.id} fields={['white']} />
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
                    value={softFor('hue') ?? prm.color?.h ?? 0} nudged={softFor('hue') !== undefined}
                    onChange={(v) => setP('hue', v, (pt) => (pt.params.color = { h: v, s: pt.params.color?.s ?? 1 }))}
                    fmt={(v) => `${Math.round(v)}°`}
                    help="hue — the colour round the wheel. Saturation is the fader beside it"
                    label=""
                  />
                  <Fader
                    label="sat"
                    width={90}
                    value={softFor('sat') ?? prm.color?.s ?? 1} nudged={softFor('sat') !== undefined}
                    def={1}
                    onChange={(v) => setP('sat', v, (pt) => (pt.params.color = { h: pt.params.color?.h ?? 0, s: v }))}
                    fmt={fmtPct}
                    variant="dim"
                  />
                  <div className="swatches">
                    {SWATCHES.map((sw, i) => {
                      const [r, g, b] = hsvToRgb(sw.h, sw.s, 1);
                      return (
                        <i
                          key={i}
                          role="button"
                          tabIndex={0}
                          aria-label={`colour swatch ${i + 1}`}
                          title="set this colour"
                          style={{ background: rgbHex(r, g, b) }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                          onClick={() => setColour(sw.h, sw.s)}
                        />
                      );
                    })}
                  </div>
                  <button
                    ref={colourChip}
                    className="huecurrent"
                    title="open the colour picker — the disc is hue round and saturation out from the middle"
                    aria-label="open the colour picker"
                    style={{ background: prm.color ? rgbHex(...hsvToRgb(prm.color.h, prm.color.s, 1)) : 'var(--swatch-neutral)' }}
                    onClick={() => setWheel((v) => !v)}
                  />
                  {wheel && (
                    <ColourWheel
                      h={softFor('hue') ?? prm.color?.h ?? 0}
                      s={softFor('sat') ?? prm.color?.s ?? 1}
                      anchor={colourChip}
                      onPick={setColour}
                      onClose={() => setWheel(false)}
                    />
                  )}
                </div>
                <DialMenu lookId={lookId} partId={part.id} fields={['hue', 'sat']} />
              </div>
            )}

            {kinds.has('derby') && (
              <>
                <div className="paramrow">
                  <span className="label" style={{ marginLeft: 20 }}>derby colour</span>
                  <select
                    className="sel"
                    title="derbies mix colour from fixed slots rather than RGB — auto picks the slot nearest the colour above"
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
                    <Fader help="the fixture's own built-in ring effect, where it has one" value={softFor('ringFx') ?? prm.ringFx ?? 0.5} nudged={softFor('ringFx') !== undefined} onChange={(v) => setP('ringFx', v, (pt) => (pt.params.ringFx = v))} fmt={fmtPct} width={180} variant="dim" />
                  </div>
                  <DialMenu lookId={lookId} partId={part.id} fields={['ringFx']} />
                </div>
              </>
            )}
          </>
        )}

        {shown === 'position' && (
          <>
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
                  <Fader label="pan" width={140} value={softFor('pan') ?? prm.pan ?? 0.5} nudged={softFor('pan') !== undefined} def={0.5} onChange={(v) => setP('pan', v, (pt) => (pt.params.pan = v))} fmt={fmtPct} variant="dim" />
                  <Fader label="tilt" width={140} value={softFor('tilt') ?? prm.tilt ?? 0.5} nudged={softFor('tilt') !== undefined} def={0.5} onChange={(v) => setP('tilt', v, (pt) => (pt.params.tilt = v))} fmt={fmtPct} variant="dim" />
                </div>
                <DialMenu lookId={lookId} partId={part.id} fields={['pan', 'tilt']} />
              </div>
            )}
            {kinds.has('derby') && (
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
                    value={softFor('motorValue') ?? prm.motorValue ?? 0.3} nudged={softFor('motorValue') !== undefined}
                    onChange={(v) => setP('motorValue', v, (pt) => (pt.params.motorValue = v))}
                    fmt={fmtPct}
                    variant="dim"
                  />
                </div>
                <DialMenu lookId={lookId} partId={part.id} fields={['motorValue']} />
              </div>
            )}
          </>
        )}

        {shown === 'beam' && (
          <>
            {/* Nothing in the group takes a beam parameter, but something in it
                HAS beam channels that are simply not driven — the profile came from
                a thin GDTF or an older importer. Without this the editor just looks
                like it forgot zoom, which is exactly how it was reported. */}
            {BEAM_PARAMS.every((k) => !beamCaps[k]) && caps.deadBeam && (
              <div className="row">
                <span className="label" style={{ color: 'var(--warn)' }}>⚠</span>
                <span className="prose">
                  This group's fixtures list zoom, focus, beam size, soften or warmth channels that their
                  profile does not drive — re-import their GDTF in the Fixtures tab to get
                  the controls
                </span>
              </div>
            )}
            {BEAM_FADERS.filter((k) => beamCaps[k]).map((k) => beamRow(k, k === 'cto' ? optics.ctoK : undefined))}

            {/* Optics: each wheel's slot picker, then its rotation where the
                fixture has one. A slot is an index into the fixture's own wheel,
                so the names are the picker and the same pick lands on every
                fixture in the group. */}
            {optics.gobos.length > 0 && (
              <SlotRow
                label="gobo"
                title="which gobo the wheel shows — the fixture's own slots, 0 is open. Not set leaves the wheel where the fixture parks it"
                names={optics.gobos}
                value={prm.gobo}
                onChange={(v) => edit((pt) => (pt.params.gobo = v))}
              />
            )}
            {beamCaps.goboRotate && beamRow('goboRotate')}
            {optics.prisms.length > 0 && (
              <SlotRow
                label="prism"
                title="which prism is in the beam — the fixture's own slots, 0 is none. Not set leaves it where the fixture parks it"
                names={optics.prisms}
                value={prm.prism}
                onChange={(v) => edit((pt) => (pt.params.prism = v))}
              />
            )}
            {beamCaps.prismRotate && beamRow('prismRotate')}
            {/* A Spiider's centre flower: the same fader shape as a wheel spin,
                middle still, either end full speed one way. Only where the
                fixture actually has the channel. */}
            {beamCaps.flower && beamRow('flower')}
          </>
        )}

        {shown === 'haze' && (
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
              <Fader label="output" width={140} value={softFor('haze') ?? prm.haze ?? 0.5} nudged={softFor('haze') !== undefined} onChange={(v) => setP('haze', v, (pt) => (pt.params.haze = v))} fmt={fmtPct} variant="dim" />
              <Fader label="haze fan" width={140} value={softFor('fan') ?? prm.fan ?? 0.35} nudged={softFor('fan') !== undefined} onChange={(v) => setP('fan', v, (pt) => (pt.params.fan = v))} fmt={fmtPct} variant="dim" />
            </div>
            <DialMenu lookId={lookId} partId={part.id} fields={['haze', 'fan']} />
          </div>
        )}

        {part.effects.map((fx) => (
          <EffectRow
            key={fx.id}
            fx={fx}
            kinds={kinds}
            canAim={canAim}
            beamCaps={beamCaps}
            headsPerFixture={caps.headsPerFixture}
            lookId={lookId}
            partId={part.id}
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
          {/* The factory catalogue. Named starting points, because "+ effect"
              above gives a blank sine on dimmer and everything worth having is
              several knobs away from it. */}
          <button
            ref={fxPickerBtn}
            className="btn small ghost"
            title="browse ready-made effects — pick one to hear it on this part straight away"
            onClick={() => setFxPickerOpen(true)}
          >
            browse…
          </button>
          {fxPickerOpen && (
            <FxPicker
              capable={new Set(capableTargets(kinds, canAim, beamCaps))}
              anchor={fxPickerBtn}
              onPreview={previewPreset}
              onKeep={() => closePicker(true)}
              onCancel={() => closePicker(false)}
            />
          )}
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
