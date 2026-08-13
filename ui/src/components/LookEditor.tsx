import React from 'react';
import type { Effect, EffectTarget, Look, LookPart, Project, Wave } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { DERBY_MACROS, hsvToRgb, rgbHex } from '../../../shared/color.ts';
import { PROFILES, type HeadKind } from '../../../shared/profiles.ts';
import { useStore } from '../store.ts';
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
    const head = fixture ? PROFILES[fixture.profileId]?.heads[ref.head] : null;
    if (head) kinds.add(head.kind);
  }
  return kinds;
}

function Enable({ on, toggle }: { on: boolean; toggle: () => void }) {
  return <div className={`enable ${on ? 'on' : ''}`} onClick={toggle} />;
}

function EffectRow({ fx, kinds, onEdit, onRemove }: {
  fx: Effect;
  kinds: Set<HeadKind>;
  onEdit: (fn: (e: Effect) => void) => void;
  onRemove: () => void;
}) {
  const targets: EffectTarget[] = ['dimmer'];
  if (kinds.has('rgb') || kinds.has('derby') || kinds.has('mover')) targets.push('hue', 'strobe');
  if (kinds.has('derby')) targets.push('white');
  if (kinds.has('mover')) targets.push('pan', 'tilt');

  return (
    <div className="fxrow">
      <select className="sel" value={fx.target} onChange={(e) => onEdit((x) => (x.target = e.target.value as EffectTarget))}>
        {targets.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <select className="sel" value={fx.wave} onChange={(e) => onEdit((x) => (x.wave = e.target.value as Wave))}>
        {WAVES.map((w) => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>
      <select
        className="sel"
        value={String(fx.rate)}
        onChange={(e) => onEdit((x) => (x.rate = Number(e.target.value)))}
      >
        {RATES.map((r) => (
          <option key={r.v} value={String(r.v)}>{r.label}</option>
        ))}
      </select>
      <Fader label="size" width={90} value={fx.size} def={1} onChange={(v) => onEdit((x) => (x.size = v))} fmt={pct} variant="dim" />
      <Fader label="spread" width={90} value={fx.spread} def={0} onChange={(v) => onEdit((x) => (x.spread = v))} fmt={pct} variant="dim" />
      {(fx.wave === 'square' || fx.wave === 'chase') && (
        <Fader label="width" width={90} value={fx.width} def={0.5} onChange={(v) => onEdit((x) => (x.width = v))} fmt={pct} variant="dim" />
      )}
      <Fader label="phase" width={80} value={fx.phase} def={0} onChange={(v) => onEdit((x) => (x.phase = v))} fmt={pct} variant="dim" />
      <button className="btn small ghost" onClick={onRemove}>✕</button>
    </div>
  );
}

function PartEditor({ lookId, part }: { lookId: string; part: LookPart }) {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const kinds = groupKinds(project, part.groupId);

  const edit = (fn: (pt: LookPart) => void) =>
    mutate((p) => {
      const pt = p.looks[lookId]?.parts.find((x) => x.id === part.id);
      if (pt) fn(pt);
    });

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
        >
          remove part
        </button>
      </div>
      <div className="partbody">
        {kinds.size > 0 && !(kinds.size === 1 && kinds.has('hazer')) && (
          <div className="paramrow">
            <Enable on={prm.dimmer !== undefined} toggle={() => edit((pt) => (pt.params.dimmer = pt.params.dimmer === undefined ? 1 : undefined))} />
            <span className="label">dimmer</span>
            <div className={`grow paramrow ${prm.dimmer === undefined ? 'off' : ''}`} style={{ gap: 8 }}>
              <Fader value={prm.dimmer ?? 1} def={1} onChange={(v) => edit((pt) => (pt.params.dimmer = v))} fmt={pct} width="100%" />
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
                value={prm.color?.h ?? 0}
                onChange={(v) => edit((pt) => (pt.params.color = { h: v, s: pt.params.color?.s ?? 1 }))}
                fmt={(v) => `${Math.round(v)}°`}
                label=""
              />
              <Fader
                label="sat"
                width={90}
                value={prm.color?.s ?? 1}
                def={1}
                onChange={(v) => edit((pt) => (pt.params.color = { h: pt.params.color?.h ?? 0, s: v }))}
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
                      onClick={() => edit((pt) => (pt.params.color = { ...sw }))}
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
                <Fader value={prm.ringFx ?? 0.5} onChange={(v) => edit((pt) => (pt.params.ringFx = v))} fmt={pct} width={180} variant="dim" />
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
                    <button key={m} className={prm.motorMode === m ? 'on' : ''} onClick={() => edit((pt) => (pt.params.motorMode = m))}>
                      {m}
                    </button>
                  ))}
                </div>
                <Fader
                  label={prm.motorMode === 'aim' ? 'position' : 'speed'}
                  width={160}
                  value={prm.motorValue ?? 0.3}
                  onChange={(v) => edit((pt) => (pt.params.motorValue = v))}
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
              <Fader value={prm.strobe ?? 0.6} onChange={(v) => edit((pt) => (pt.params.strobe = v))} fmt={pct} width={180} variant="dim" />
            </div>
          </div>
        )}

        {kinds.has('mover') && (
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
              <Fader label="pan" width={140} value={prm.pan ?? 0.5} def={0.5} onChange={(v) => edit((pt) => (pt.params.pan = v))} fmt={pct} variant="dim" />
              <Fader label="tilt" width={140} value={prm.tilt ?? 0.5} def={0.5} onChange={(v) => edit((pt) => (pt.params.tilt = v))} fmt={pct} variant="dim" />
            </div>
          </div>
        )}

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
              <Fader label="output" width={140} value={prm.haze ?? 0.5} onChange={(v) => edit((pt) => (pt.params.haze = v))} fmt={pct} variant="dim" />
              <Fader label="fan" width={140} value={prm.fan ?? 0.35} onChange={(v) => edit((pt) => (pt.params.fan = v))} fmt={pct} variant="dim" />
            </div>
          </div>
        )}

        {part.effects.map((fx) => (
          <EffectRow
            key={fx.id}
            fx={fx}
            kinds={kinds}
            onEdit={(fn) => edit((pt) => {
              const e = pt.effects.find((x) => x.id === fx.id);
              if (e) fn(e);
            })}
            onRemove={() => edit((pt) => (pt.effects = pt.effects.filter((x) => x.id !== fx.id)))}
          />
        ))}
        <div className="row">
          <button
            className="btn small ghost"
            onClick={() => edit((pt) => pt.effects.push({ id: uid('fx'), target: 'dimmer', wave: 'sine', rate: 4, size: 1, spread: 0, width: 0.5, phase: 0 }))}
          >
            + effect
          </button>
        </div>
      </div>
    </div>
  );
}

export function LookEditor() {
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);

  if (!sel) return <div className="hint">Select a cell in the grid to edit its look — or click an empty cell to create one.</div>;

  const layer = project.layers.find((l) => l.id === sel.layerId);
  if (!layer) return <div className="hint">Layer no longer exists.</div>;
  const lookId = layer.cells[sel.col] ?? null;
  const look: Look | null = lookId ? project.looks[lookId] ?? null : null;

  if (!look || !lookId) {
    return (
      <div className="hint">
        <div style={{ marginBottom: 10 }}>
          Empty cell — {layer.name} · column {sel.col + 1}
        </div>
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
        >
          + create look here
        </button>
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
        <input
          className="text"
          style={{ width: 220, fontSize: 13 }}
          value={look.name}
          onChange={(e) => editLook((lk) => (lk.name = e.target.value))}
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
        <button className="btn small ghost" onClick={() => send({ type: 'trigger', layerId: layer.id, col: sel.col })}>
          ▶ fire
        </button>
        <div className="grow" />
        <button
          className="btn small ghost"
          onClick={() => mutate((p) => {
            const ly = p.layers.find((l) => l.id === sel.layerId);
            if (ly) ly.cells[sel.col] = null;
          })}
        >
          clear cell
        </button>
        <button
          className="btn small ghost"
          onClick={() => mutate((p) => {
            delete p.looks[lookId];
            for (const ly of p.layers) ly.cells = ly.cells.map((c) => (c === lookId ? null : c));
          })}
        >
          delete look
        </button>
      </div>

      {look.parts.map((part) => (
        <PartEditor key={part.id} lookId={lookId} part={part} />
      ))}

      <div className="row">
        <button
          className="btn small ghost"
          onClick={() => editLook((lk) => lk.parts.push({ id: uid('part'), groupId: project.groups[0]?.id ?? '', params: { dimmer: 1 }, effects: [] }))}
        >
          + part (fixture group)
        </button>
      </div>
    </div>
  );
}
