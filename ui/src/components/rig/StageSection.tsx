// The stage: the room's size, the structures drawn in it, and the musicians
// the aim strip points at.
//
// Placing by dragging in the plan gets you close; a truss that has to be
// exactly 6 m, or a riser at exactly 0.6 m, needs numbers. Selection is shared
// with the plan through the store, so a row highlights what it refers to.

import React from 'react';
import { Glyph } from '../../glyphs.tsx';
import type { StageProp, StagePropKind } from '../../../../shared/types.ts';
import { STRUCTURE_DEFAULTS, isStructure, uid } from '../../../../shared/types.ts';
import { stageExtent } from '../../../../shared/stageExtent.ts';
import { useStore } from '../../store.ts';
import { ScrubNumInput } from '../inputs.tsx';
import { onControl } from './parts.tsx';

const round2 = (v: number) => Math.round(v * 100) / 100;

const STRUCTURE_LABEL: Record<string, string> = {
  trussBar: 'truss bar', trussLeg: 'truss leg', riser: 'riser', screen: 'screen',
};

/** The stage as a box (backlog #14). Auto fits the plan, the in-app 3D and the
 *  stage window to whatever is placed; a set size is drawn as typed, on the
 *  plan's origin — the width across, the depth toward the audience, the height
 *  to the grid. */
function StageSizeRow(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const stage = project.stage;
  const ext = stageExtent(project);
  const num = (value: number, title: string, set: (v: number) => void) => (
    <ScrubNumInput
      value={value}
      scrubStep={0.1}
      decimals={1}
      width={52}
      title={title}
      onSet={(v) => set(round2(v))}
      onDelta={(d) => set(round2(value + d))}
    />
  );
  const setSide = (k: 'w' | 'd' | 'h', v: number) =>
    mutate((p) => {
      if (p.stage) p.stage = { ...p.stage, [k]: Math.max(1, v) };
    }, 'resize the stage');
  return (
    <div className="inspectgrid" style={{ marginBottom: 8 }}>
      <span
        className="label"
        title="the stage as the plan, the 3D views and the stage window draw it — width across, depth toward the audience, height to the grid, centred on the plan's origin"
      >
        size
      </span>
      {stage ? (
        <>
          {num(stage.w, 'width across the stage, metres', (v) => setSide('w', v))}
          <span className="label">×</span>
          {num(stage.d, 'depth toward the audience, metres', (v) => setSide('d', v))}
          <span className="label">×</span>
          {num(stage.h, 'height to the grid, metres', (v) => setSide('h', v))}
          <span className="label">m</span>
          <button
            className="btn small ghost"
            title="back to fitting the stage to whatever is placed"
            onClick={() => mutate((p) => { delete p.stage; }, 'stage size back to auto')}
          >
            auto
          </button>
        </>
      ) : (
        <>
          <span className="prose" style={{ flex: '0 1 auto' }}>
            auto — fits whatever is placed, {ext.x1 - ext.x0} × {ext.z1 - ext.z0} m now
          </span>
          <button
            className="btn small ghost"
            title="give the stage a fixed size — the plan, the 3D views and the stage window all draw it as typed"
            onClick={() => mutate((p) => { p.stage = { w: ext.x1 - ext.x0, d: ext.z1 - ext.z0, h: ext.yTop }; }, 'set the stage size')}
          >
            set a size
          </button>
        </>
      )}
    </div>
  );
}

/** What can be put on the plan. Musicians are what the aim strip aims at;
 *  structures are what fixtures are rigged on and what beams stop against. */
function AddProps(): React.ReactElement {
  const mutate = useStore((s) => s.mutate);
  const addStructure = (kind: string) => {
    const d = STRUCTURE_DEFAULTS[kind];
    if (!d) return;
    mutate((p) => {
      p.props ??= [];
      p.props.push({
        id: uid('prop'),
        kind: kind as StagePropKind,
        pos: { x: 0, z: kind === 'screen' ? -1.6 : 0 },
        size: { w: d.w, h: d.h, d: d.d },
        y: d.y,
      });
    }, `add a ${STRUCTURE_LABEL[kind] ?? kind}`);
  };
  const addMusician = (kind: string) => {
    const KINDS: StagePropKind[] = ['vocalist', 'guitarist', 'bassist', 'drummer', 'keyboardist'];
    mutate((p) => {
      p.props ??= [];
      if (kind === 'band') {
        const layout: [StagePropKind, number, number][] = [
          ['vocalist', 0, 1.9], ['guitarist', -1.7, 1.2], ['bassist', 1.7, 1.2],
          ['drummer', 0, 0.1], ['keyboardist', -3.0, 0.6],
        ];
        for (const [k, x, z] of layout) p.props.push({ id: uid('prop'), kind: k, pos: { x, z } });
      } else if ((KINDS as string[]).includes(kind)) {
        p.props.push({ id: uid('prop'), kind: kind as StagePropKind, pos: { x: 0, z: 1.2 } });
      }
    }, 'add someone to the plan');
  };
  return (
    <div className="inspectgrid" style={{ marginBottom: 8 }}>
      <select
        className="sel"
        value=""
        title="add someone to stand on the plan — drag to place them, double-click in the plan to remove"
        onChange={(e) => { if (e.target.value) addMusician(e.target.value); e.target.value = ''; }}
      >
        <option value="">+ musician…</option>
        <option value="vocalist">vocalist</option>
        <option value="guitarist">guitarist</option>
        <option value="bassist">bassist</option>
        <option value="drummer">drummer</option>
        <option value="keyboardist">keyboardist</option>
        <option value="band">full band</option>
      </select>
      <select
        className="sel"
        value=""
        title="draw the stage — drag to place it in the plan, double-click in the plan to remove"
        onChange={(e) => { if (e.target.value) addStructure(e.target.value); e.target.value = ''; }}
      >
        <option value="">+ structure…</option>
        <option value="trussBar">truss bar</option>
        <option value="trussLeg">truss leg</option>
        <option value="riser">riser</option>
        <option value="screen">screen</option>
      </select>
    </div>
  );
}

export function StageSection(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const propSel = useStore((s) => s.propSel);
  const setPropSel = useStore((s) => s.setPropSel);
  const items = (project.props ?? []).filter((p) => isStructure(p.kind));

  const edit = (id: string, fn: (p: StageProp) => void, label?: string) =>
    mutate((p) => {
      const target = (p.props ?? []).find((x) => x.id === id);
      if (target) fn(target);
    }, label);
  const sizeOf = (pr: StageProp) => pr.size ?? STRUCTURE_DEFAULTS[pr.kind] ?? { w: 1, h: 1, d: 1 };

  return (
    <>
      <div className="sectionhead" data-setup="stage">Stage</div>
      <StageSizeRow />
      <AddProps />
      {items.length === 0 ? (
        <div className="rigempty">nothing drawn yet — add truss, risers or screens above, then drag them into place on the plan</div>
      ) : (
        <table className="rigtbl">
          <thead>
            <tr>
              <th>Piece</th><th>X</th><th>Z</th><th>Base Y</th>
              <th>Width</th><th>Height</th><th>Depth</th><th>Rot°</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((pr) => {
              const s = sizeOf(pr);
              const selected = propSel.includes(pr.id);
              const num = (value: number, step: number, title: string, set: (v: number) => void) => (
                <ScrubNumInput
                  value={value}
                  scrubStep={step}
                  decimals={2}
                  width={52}
                  title={title}
                  onSet={(v) => set(round2(v))}
                  onDelta={(d) => set(round2(value + d))}
                />
              );
              return (
                <tr
                  key={pr.id}
                  className={selected ? 'rowsel' : ''}
                  onPointerDown={(e) => {
                    if (onControl(e.target)) return;
                    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                    setPropSel(
                      additive
                        ? propSel.includes(pr.id) ? propSel.filter((x) => x !== pr.id) : [...propSel, pr.id]
                        : [pr.id],
                    );
                  }}
                >
                  <td className="mono">{STRUCTURE_LABEL[pr.kind] ?? pr.kind}</td>
                  <td>{num(pr.pos.x, 0.02, 'across the stage', (v) => edit(pr.id, (x) => { x.pos.x = v; }, 'move a structure'))}</td>
                  <td>{num(pr.pos.z, 0.02, 'toward the audience', (v) => edit(pr.id, (x) => { x.pos.z = v; }, 'move a structure'))}</td>
                  <td>{num(pr.y ?? 0, 0.02, 'height of the base off the floor', (v) => edit(pr.id, (x) => { x.y = v; }, 'move a structure'))}</td>
                  <td>{num(s.w, 0.05, 'width', (v) => edit(pr.id, (x) => { x.size = { ...sizeOf(x), w: Math.max(0.05, v) }; }, 'resize a structure'))}</td>
                  <td>{num(s.h, 0.05, 'height', (v) => edit(pr.id, (x) => { x.size = { ...sizeOf(x), h: Math.max(0.05, v) }; }, 'resize a structure'))}</td>
                  <td>{num(s.d, 0.05, 'depth', (v) => edit(pr.id, (x) => { x.size = { ...sizeOf(x), d: Math.max(0.05, v) }; }, 'resize a structure'))}</td>
                  <td>
                    <ScrubNumInput
                      value={Math.round(((pr.rotY ?? 0) * 180) / Math.PI)}
                      scrubStep={1}
                      decimals={0}
                      width={52}
                      title="rotation"
                      onSet={(v) => edit(pr.id, (x) => { x.rotY = (v * Math.PI) / 180; }, 'turn a structure')}
                      onDelta={(d) => edit(pr.id, (x) => { x.rotY = (x.rotY ?? 0) + (d * Math.PI) / 180; }, 'turn a structure')}
                    />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn small ghost"
                      title="duplicate — lands 0.5 m across so it is not hidden underneath"
                      onClick={() => mutate((p) => {
                        const src = (p.props ?? []).find((x) => x.id === pr.id);
                        if (!src) return;
                        p.props ??= [];
                        p.props.push({
                          ...structuredClone(src),
                          id: uid('prop'),
                          pos: { x: round2(src.pos.x + 0.5), z: src.pos.z },
                        });
                      }, 'duplicate a structure')}
                    >
                      ⧉
                    </button>
                    <button
                      className="btn small ghost"
                      title="delete"
                      onClick={() => mutate((p) => {
                        p.props = (p.props ?? []).filter((x) => x.id !== pr.id);
                        if (p.props.length === 0) delete p.props;
                        // Anything rigged on it is no longer rigged on
                        // anything. Positions are in room coordinates, so the
                        // fixtures stay exactly where they are — they simply
                        // stop having a parent.
                        for (const f of p.fixtures) {
                          if (f.parentId === pr.id) delete f.parentId;
                        }
                      }, 'delete a structure')}
                    >
                      <Glyph name="clear" alone />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="prose" style={{ marginTop: 6 }}>
        Drag a row’s numbers to scrub them; shift-click rows to select more than one. ⧉ duplicates, <Glyph name="clear" /> deletes.
      </div>
    </>
  );
}
