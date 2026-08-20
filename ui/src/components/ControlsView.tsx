import React from 'react';
import type { Control, ControlLink, SoftField } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
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

function LinkRow({ link, onEdit, onRemove }: {
  link: ControlLink;
  onEdit: (fn: (l: ControlLink) => void) => void;
  onRemove: () => void;
}) {
  const project = useStore((s) => s.project)!;
  const look = Object.hasOwn(project.looks, link.lookId) ? project.looks[link.lookId] : undefined;
  const part = look?.parts.find((pt) => pt.id === link.partId);
  const dangling = !part || (link.effectId !== undefined && !part.effects.some((e) => e.id === link.effectId));

  const num = (v: number, set: (x: number) => void, title: string) => (
    <input
      className="num"
      type="number"
      step={0.05}
      style={{ width: 64 }}
      title={title}
      value={v}
      onChange={(e) => {
        const x = Number(e.target.value);
        if (Number.isFinite(x)) set(x);
      }}
    />
  );

  return (
    <div className="row" style={{ marginBottom: 4, paddingLeft: 16 }}>
      {dangling && (
        <span className="label" title="this link's look, part or effect no longer exists — it is skipped when the control moves" style={{ color: 'var(--amber, #f0a63e)' }}>
          ⚠
        </span>
      )}
      <select
        className="sel"
        value={link.lookId}
        onChange={(e) => onEdit((l) => {
          l.lookId = e.target.value;
          const lk = project.looks[e.target.value];
          l.partId = lk?.parts[0]?.id ?? '';
          delete l.effectId;
        })}
      >
        {!look && <option value={link.lookId}>(missing look)</option>}
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
      {num(link.min, (x) => onEdit((l) => (l.min = x)), 'value at fader 0 — set min above max to invert')}
      <span className="label">max</span>
      {num(link.max, (x) => onEdit((l) => (l.max = x)), 'value at fader 1')}
      <button className="btn small ghost" onClick={onRemove}>✕</button>
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

  return (
    <div>
      <div className="sectionhead">Named Controls — live faders fanning to parameters</div>
      <div className="label" style={{ marginBottom: 8 }}>
        One fader, many parameters, each through its own min→max bracket (min above max inverts).
        Moves ride the soft layer: Store/Discard in the top bar apply. MIDI-learnable like any fader.
      </div>
      {controls.map((c) => {
        const liveValue = live?.find((x) => x.id === c.id)?.value;
        return (
          <div key={c.id} style={{ marginBottom: 14, borderLeft: '2px solid var(--line2, #333)', paddingLeft: 8 }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <TextField
                className="text"
                style={{ width: 150, fontSize: 13 }}
                entityId={c.id}
                value={c.name}
                onCommit={(v) => editControl(c.id, (x) => (x.name = v))}
              />
              <Fader
                width={220}
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
                className="btn small ghost"
                onClick={() => mutate((p) => {
                  p.controls = (p.controls ?? []).filter((x) => x.id !== c.id);
                  if (p.controls.length === 0) delete p.controls;
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
              >
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
      >
        + add control
      </button>
    </div>
  );
}
