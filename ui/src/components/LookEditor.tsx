import React, { useEffect, useState } from 'react';
import type { Effect, EffectTarget, Look, LookPart, Project, Wave } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { DERBY_MACROS, hsvToRgb, rgbHex } from '../../../shared/color.ts';
import { type HeadKind } from '../../../shared/profiles.ts';
import { TextField } from './inputs.tsx';
import { profileMeta } from '../profileInfo.ts';
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

/** Beats editor that commits on blur/Enter — per-keystroke clamping made
 *  fractional values untypeable ("0.5" clamped at "0") and the field
 *  unclearable. */
function BeatsInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    const clean = Number.isFinite(v) && v > 0 ? Math.min(v, 512) : 1;
    setDraft(String(clean));
    if (clean !== value) onCommit(clean);
  };
  return (
    <input
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

  if (!sel) return <div className="hint">Select a cell in the grid to edit its look — or click an empty cell to create one.</div>;

  const layer = project.layers.find((l) => l.id === sel.layerId);
  if (!layer) return <div className="hint">Layer no longer exists.</div>;
  const lookId = layer.cells[sel.col] ?? null;
  const look: Look | null = lookId ? project.looks[lookId] ?? null : null;

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
          >
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
        <button className="btn small ghost" onClick={() => send({ type: 'trigger', layerId: layer.id, col: sel.col })}>
          ▶ fire
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
        >
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
              if (refs.length > 0 || decksHit.length > 0) {
                const parts: string[] = [];
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
        >
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
                {(!project.looks[st.lookId] || project.looks[st.lookId]?.steps?.length) ? (
                  <option value={st.lookId}>
                    {project.looks[st.lookId] ? '(cue list - renders dark)' : '(missing look)'}
                  </option>
                ) : null}
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
            <PartEditor key={part.id} lookId={lookId} part={part} />
          ))}

          <div className="row">
            <button
              className="btn small ghost"
              onClick={() => editLook((lk) => lk.parts.push({ id: uid('part'), groupId: project.groups[0]?.id ?? '', params: { dimmer: 1 }, effects: [] }))}
            >
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
        </>
      )}
    </div>
  );
}
