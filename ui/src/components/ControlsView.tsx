import React from 'react';
import type { Control, ControlLink, ModBinding, Modulator, SoftField, Wave } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { WAVE_LABEL } from '../labels.ts';
import { Fader } from './Fader.tsx';
import { TextField } from './inputs.tsx';

/** Named Controls (P3) — the macro answer. A control is a typed live fader
 *  fanning out to parameters through per-link min/max brackets: no strings,
 *  no conditionals, and "what drives this" is data you can read right here.
 *  Moving the fader resolves through the P1 soft layer, so Store/Discard in
 *  the top bar work on control moves exactly like hand rides. */

const PART_FIELDS: SoftField[] = [
  'dimmer', 'hue', 'sat', 'white', 'strobe', 'pan', 'tilt', 'ringFx', 'motorValue',
  'haze', 'fan', 'zoom', 'focus', 'iris', 'frost', 'cto',
];
const EFFECT_FIELDS: SoftField[] = ['rate', 'size', 'spread', 'width', 'phase', 'mix'];

/** Float editor that commits on blur/Enter — the BeatsInput discipline: a
 *  per-keystroke commit makes the field unclearable (Number('') is 0), eats a
 *  leading minus, and floods a project write per keypress. */
function NumInput({ value, title, onCommit }: { value: number; title?: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = React.useState(String(value));
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Number(draft);
    const clean = draft.trim() !== '' && Number.isFinite(v) ? v : value;
    setDraft(String(clean));
    if (clean !== value) onCommit(clean);
  };
  return (
    <input
      ref={ref}
      className="num"
      type="number"
      step={0.05}
      style={{ width: 64 }}
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

function LinkRow({ link, onEdit, onRemove }: {
  link: ControlLink;
  onEdit: (fn: (l: ControlLink) => void) => void;
  onRemove: () => void;
}) {
  const project = useStore((s) => s.project)!;
  const look = Object.hasOwn(project.looks, link.lookId) ? project.looks[link.lookId] : undefined;
  const part = look?.parts.find((pt) => pt.id === link.partId);
  // [K] a look converted to a cue list keeps its parts but never renders them,
  // so a link onto it fans onto nothing — dangling in every way that matters
  const dangling = !part || !!look?.steps?.length ||
    (link.effectId !== undefined && !part.effects.some((e) => e.id === link.effectId));

  return (
    <div className="row" style={{ marginBottom: 4, paddingLeft: 16 }}>
      {dangling && (
        <span className="label" title="this link's look, part or effect no longer exists — it is skipped when the control moves" style={{ color: 'var(--color-status-nudge)' }}>
          ⚠
        </span>
      )}
      <select
        className="sel"
        value={link.lookId}
        title="which look this link reaches into — the control does nothing until that look is on stage"
        onChange={(e) => onEdit((l) => {
          l.lookId = e.target.value;
          const lk = project.looks[e.target.value];
          l.partId = lk?.parts[0]?.id ?? '';
          delete l.effectId;
        })}
      >
        {!look && <option value={link.lookId}>(missing look)</option>}
        {look && !!look.steps?.length && (
          <option value={link.lookId}>{look.name} (steps — spreads nothing)</option>
        )}
        {Object.values(project.looks)
          .filter((l) => !l.steps?.length)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
      </select>
      <select
        className="sel"
        value={link.partId}
        title="which part of that look — each part points at one group, so this is also which fixtures move"
        onChange={(e) => onEdit((l) => {
          l.partId = e.target.value;
          delete l.effectId;
        })}
      >
        {!part && <option value={link.partId}>(missing part)</option>}
        {(look?.parts ?? []).map((pt, i) => {
          const g = project.groups.find((x) => x.id === pt.groupId);
          return (
            <option key={pt.id} value={pt.id}>part {i + 1} · {g?.name ?? pt.groupId}</option>
          );
        })}
      </select>
      <select
        className="sel"
        value={link.effectId !== undefined ? `fx:${link.effectId}:${link.field}` : `p:${link.field}`}
        title="which parameter this link drives — part fields, or a knob of one of the part's effects"
        onChange={(e) => onEdit((l) => {
          const v = e.target.value;
          if (v.startsWith('p:')) {
            delete l.effectId;
            l.field = v.slice(2) as SoftField;
          } else {
            const [, effectId, field] = v.split(':');
            l.effectId = effectId;
            l.field = field as SoftField;
          }
        })}
      >
        <optgroup label="part">
          {PART_FIELDS.map((f) => (
            <option key={f} value={`p:${f}`}>{f}</option>
          ))}
        </optgroup>
        {(part?.effects ?? []).map((e, i) => (
          <optgroup key={e.id} label={`effect ${i + 1} · ${e.target} ${e.wave}`}>
            {EFFECT_FIELDS.map((f) => (
              <option key={f} value={`fx:${e.id}:${f}`}>{f}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="label">min</span>
      <NumInput value={link.min} title="value at fader 0 — set min above max to invert" onCommit={(x) => onEdit((l) => (l.min = x))} />
      <span className="label">max</span>
      <NumInput value={link.max} title="value at fader 1" onCommit={(x) => onEdit((l) => (l.max = x))} />
      <button title="remove this link — the control stops driving that parameter" className="btn small ghost" onClick={onRemove}>✕</button>
    </div>
  );
}

const MOD_WAVES: Wave[] = ['sine', 'triangle', 'sawUp', 'sawDown', 'square', 'random'];
const MOD_RATES: { v: number; label: string }[] = [
  { v: 32, label: '8 bars' }, { v: 16, label: '4 bars' }, { v: 8, label: '2 bars' },
  { v: 4, label: '1 bar' }, { v: 2, label: '2 beats' }, { v: 1, label: '1 beat' },
  { v: 0.5, label: '1/2' }, { v: 0.25, label: '1/4' },
];

/** rate is deliberately absent: modulating it per tick would turn the P4
 *  phase-continuity map into a tick-schedule-dependent integrator. */
const MOD_EFFECT_FIELDS: SoftField[] = ['size', 'spread', 'width', 'phase', 'mix'];

function BindingRow({ b, onEdit, onRemove }: {
  b: ModBinding;
  onEdit: (fn: (x: ModBinding) => void) => void;
  onRemove: () => void;
}) {
  const project = useStore((s) => s.project)!;
  const look = Object.hasOwn(project.looks, b.lookId) ? project.looks[b.lookId] : undefined;
  const part = look?.parts.find((pt) => pt.id === b.partId);
  const dangling = !part || !!look?.steps?.length ||
    (b.effectId !== undefined && !part.effects.some((e) => e.id === b.effectId));
  return (
    <div className="row" style={{ marginBottom: 4, paddingLeft: 16 }}>
      {dangling && (
        <span className="label" title="this binding's look, part or effect no longer exists — the pulse skips it" style={{ color: 'var(--color-status-nudge)' }}>
          ⚠
        </span>
      )}
      <select
        className="sel"
        value={b.lookId}
        title="which look this binding nudges — it offsets whatever the look and any nudge have already set"
        onChange={(e) => onEdit((x) => {
          x.lookId = e.target.value;
          const lk = project.looks[e.target.value];
          x.partId = lk?.parts[0]?.id ?? '';
          delete x.effectId;
        })}
      >
        {!look && <option value={b.lookId}>(missing look)</option>}
        {look && !!look.steps?.length && (
          <option value={b.lookId}>{look.name} (steps — spreads nothing)</option>
        )}
        {Object.values(project.looks)
          .filter((l) => !l.steps?.length)
          .sort((a2, b2) => a2.name.localeCompare(b2.name))
          .map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
      </select>
      <select
        className="sel"
        value={b.partId}
        title="which part of that look — each part points at one group, so this is also which fixtures move"
        onChange={(e) => onEdit((x) => {
          x.partId = e.target.value;
          delete x.effectId;
        })}
      >
        {!part && <option value={b.partId}>(missing part)</option>}
        {(look?.parts ?? []).map((pt, i) => {
          const g = project.groups.find((x) => x.id === pt.groupId);
          return <option key={pt.id} value={pt.id}>part {i + 1} · {g?.name ?? pt.groupId}</option>;
        })}
      </select>
      <select
        className="sel"
        value={b.effectId !== undefined ? `fx:${b.effectId}:${b.field}` : `p:${b.field}`}
        title="which parameter the pulse moves — part fields, or a knob of one of the part's effects. Rate is deliberately absent: a continuously moving rate would drift the two engines apart"
        onChange={(e) => onEdit((x) => {
          const v = e.target.value;
          if (v.startsWith('p:')) {
            delete x.effectId;
            x.field = v.slice(2) as SoftField;
          } else {
            const [, effectId, field] = v.split(':');
            x.effectId = effectId;
            x.field = field as SoftField;
          }
        })}
      >
        <optgroup label="part">
          {PART_FIELDS.map((f) => (
            <option key={f} value={`p:${f}`}>{f}</option>
          ))}
        </optgroup>
        {(part?.effects ?? []).map((e, i) => (
          <optgroup key={e.id} label={`effect ${i + 1} · ${e.target} ${e.wave}`}>
            {MOD_EFFECT_FIELDS.map((f) => (
              <option key={f} value={`fx:${e.id}:${f}`}>{f}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <Fader
        label="depth"
        width={110}
        min={-1}
        max={1}
        def={0}
        value={b.depth}
        onChange={(v) => onEdit((x) => (x.depth = v))}
        fmt={(v) => `${Math.round(v * 100)}%`}
        variant="dim"
      />
      <button title="remove this binding — the pulse stops driving that parameter" className="btn small ghost" onClick={onRemove}>✕</button>
    </div>
  );
}

export function ControlsView(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const live = useStore((s) => s.snap?.controls);
  const controls = project.controls ?? [];

  const editControl = (id: string, fn: (c: Control) => void) =>
    mutate((p) => {
      const c = p.controls?.find((x) => x.id === id);
      if (c) fn(c);
    });
  const editMod = (id: string, fn: (m: Modulator) => void) =>
    mutate((p) => {
      const m = p.modulators?.find((x) => x.id === id);
      if (m) fn(m);
    });

  return (
    <div>
      <div className="sectionhead">Dials — one fader, many parameters</div>
      <div className="prose" style={{ marginBottom: 8 }}>
        One fader, many parameters, each through its own min→max bracket (min above max inverts).
        Moves are nudges — live, not stored: Keep/Discard in the top bar apply. MIDI-learnable like any fader.
      </div>
      {controls.map((c) => {
        const liveValue = live?.find((x) => x.id === c.id)?.value;
        return (
          <div key={c.id} style={{ marginBottom: 14, borderLeft: 'var(--size-rule) solid var(--line2)', paddingLeft: 8 }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <TextField
                className="text"
                title="control name — this is what the pads page shows in the control row"
                style={{ width: 150, fontSize: 13 }}
                entityId={c.id}
                value={c.name}
                onCommit={(v) => editControl(c.id, (x) => (x.name = v))}
              />
              <Fader
                width={220}
                help={`${c.name} — moving this is a nudge: live, not stored. Keep in the top bar writes it into the look`}
                value={liveValue ?? c.value}
                def={c.value}
                onChange={(v) => send({ type: 'setControl', controlId: c.id, value: v })}
                fmt={(v) => `${Math.round(v * 100)}%`}
                learn={{ kind: 'control', controlId: c.id }}
              />
              <button
                className="btn small ghost"
                title="save the current live position as this control's stored default"
                disabled={liveValue === undefined}
                onClick={() => editControl(c.id, (x) => (x.value = liveValue ?? x.value))}
              >
                set default
              </button>
              <div className="grow" />
              <button
                title="delete this control, and any MIDI bound to it"
                className="btn small ghost"
                onClick={() => mutate((p) => {
                  p.controls = (p.controls ?? []).filter((x) => x.id !== c.id);
                  if (p.controls.length === 0) delete p.controls;
                  // Take its hardware bindings with it. The APC preset binds a
                  // knob on all nine track-selection banks, so a deleted
                  // control otherwise leaves nine mappings pointing at nothing
                  // — and the knob reads as occupied when it is really free.
                  p.midi = p.midi.filter(
                    (m) => !(m.action.kind === 'control' && m.action.controlId === c.id),
                  );
                })}
              >
                ✕
              </button>
            </div>
            {c.links.map((l, i) => (
              <LinkRow
                key={i}
                link={l}
                onEdit={(fn) => editControl(c.id, (x) => { if (x.links[i]) fn(x.links[i]); })}
                onRemove={() => editControl(c.id, (x) => x.links.splice(i, 1))}
              />
            ))}
            <div className="row" style={{ paddingLeft: 16 }}>
              <button
                className="btn small ghost"
                disabled={Object.values(project.looks).every((l) => !!l.steps?.length || l.parts.length === 0)}
                onClick={() => editControl(c.id, (x) => {
                  const first = Object.values(project.looks).find((l) => !l.steps?.length && l.parts.length > 0);
                  if (first) x.links.push({ lookId: first.id, partId: first.parts[0].id, field: 'dimmer', min: 0, max: 1 });
                })}
              
            title="point this control at one more parameter, with its own min/max bracket">
                + link
              </button>
            </div>
          </div>
        );
      })}
      <button
        className="btn small"
        onClick={() => mutate((p) => {
          p.controls = [...(p.controls ?? []), { id: uid('ctl'), name: `Control ${(p.controls?.length ?? 0) + 1}`, value: 0, links: [] }];
        })}
      
            title="a dial: one knob driving many parameters at once, MIDI-mappable">
        + add dial
      </button>

      <div className="sectionhead" style={{ marginTop: 18 }}>Pulses — beat-locked waves</div>
      <div className="prose" style={{ marginBottom: 8 }}>
        Pure functions of the beat clock (they follow the speed master and tap for free), nudging each
        bound parameter about its value with a ± depth. Depth 0 is silent; negative inverts.
      </div>
      {(project.modulators ?? []).map((m) => (
        <div key={m.id} style={{ marginBottom: 14, borderLeft: 'var(--size-rule) solid var(--line2)', paddingLeft: 8 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <button
              className={`btn small ${m.on ? 'on' : 'ghost'}`}
              title={m.on
                ? 'running — click to stop (bound parameters return to their base value)'
                : 'stopped — parameters sit at their base'}
              onClick={() => editMod(m.id, (x) => (x.on = !x.on))}
            >
              {m.on ? '▶' : '◼'}
            </button>
            <TextField
              className="text"
              title="pulse name"
              style={{ width: 150, fontSize: 13 }}
              entityId={m.id}
              value={m.name}
              onCommit={(v) => editMod(m.id, (x) => (x.name = v))}
            />
            <select className="sel" title="the pulse's wave shape" value={m.wave} onChange={(e) => editMod(m.id, (x) => (x.wave = e.target.value as Wave))}>
              {MOD_WAVES.map((w) => (
                <option key={w} value={w}>{WAVE_LABEL[w]}</option>
              ))}
            </select>
            <select className="sel" title="beats per cycle — musical, not hertz, so it stays in time when the tempo moves" value={String(m.rate)} onChange={(e) => editMod(m.id, (x) => (x.rate = Number(e.target.value)))}>
              {MOD_RATES.map((r) => (
                <option key={r.v} value={String(r.v)}>{r.label}</option>
              ))}
            </select>
            <div className="grow" />
            <button
              className="btn small ghost"
              title="delete this pulse and all of its bindings"
              onClick={() => mutate((p) => {
                p.modulators = (p.modulators ?? []).filter((x) => x.id !== m.id);
                if (p.modulators.length === 0) delete p.modulators;
              })}
            >
              ✕
            </button>
          </div>
          {m.bindings.map((b, i) => (
            <BindingRow
              key={i}
              b={b}
              onEdit={(fn) => editMod(m.id, (x) => { if (x.bindings[i]) fn(x.bindings[i]); })}
              onRemove={() => editMod(m.id, (x) => x.bindings.splice(i, 1))}
            />
          ))}
          <div className="row" style={{ paddingLeft: 16 }}>
            <button
              className="btn small ghost"
              disabled={Object.values(project.looks).every((l) => !!l.steps?.length || l.parts.length === 0)}
              onClick={() => editMod(m.id, (x) => {
                const first = Object.values(project.looks).find((l) => !l.steps?.length && l.parts.length > 0);
                if (first) x.bindings.push({ lookId: first.id, partId: first.parts[0].id, field: 'dimmer', depth: 0.5 });
              })}
            
            title="bind this pulse to one more parameter; depth sets how far it swings">
              + binding
            </button>
          </div>
        </div>
      ))}
      <button
        className="btn small"
        onClick={() => mutate((p) => {
          p.modulators = [...(p.modulators ?? []), { id: uid('lfo'), name: `Pulse ${(p.modulators?.length ?? 0) + 1}`, wave: 'sine', rate: 4, phase: 0, on: true, bindings: [] }];
        })}
      
            title="a beat-locked pulse that moves parameters continuously — no pad press needed">
        + add pulse
      </button>
    </div>
  );
}
