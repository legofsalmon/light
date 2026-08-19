import React from 'react';
import { uid } from '../../../shared/types.ts';
import type { StagePropKind } from '../../../shared/types.ts';
import { STRUCTURE_DEFAULTS } from '../../../shared/types.ts';
import { createGroupFromSelection } from '../selection.ts';
import { useStore } from '../store.ts';
import { Fader } from './Fader.tsx';
import { Previz2D } from './Previz2D.tsx';
import { Previz3D } from './Previz3D.tsx';

export function PrevizPanel() {
  const mode = useStore((s) => s.previzMode);
  const setMode = useStore((s) => s.setPrevizMode);
  const view2d = useStore((s) => s.previz2dView);
  const setView2d = useStore((s) => s.setPreviz2dView);
  const hazeViz = useStore((s) => s.hazeViz);
  const setHazeViz = useStore((s) => s.setHazeViz);
  const showBand = useStore((s) => s.showBand);
  const setShowBand = useStore((s) => s.setShowBand);
  const showMeasure = useStore((s) => s.showMeasure);
  const setShowMeasure = useStore((s) => s.setShowMeasure);
  const fxSel = useStore((s) => s.fxSel);
  const sel = useStore((s) => s.sel);
  const selName = useStore((s) => {
    if (!s.sel || !s.project) return null;
    const layer = s.project.layers.find((l) => l.id === s.sel!.layerId);
    const id = layer?.cells[s.sel!.col];
    return id && Object.hasOwn(s.project.looks, id) ? s.project.looks[id].name : null;
  });
  const mutate = useStore((s) => s.mutate);

  /** Place a structural piece at its default size, centred just upstage of the
   *  band so it lands somewhere visible rather than inside a performer. */
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
    });
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
    });
  };

  return (
    <>
      <div className="previzbar">
        <span className="label">previz</span>
        <div className="seg">
          <button className={mode === '3d' ? 'on' : ''} onClick={() => setMode('3d')}>3D</button>
          <button className={mode === '2d' ? 'on' : ''} onClick={() => setMode('2d')}>2D plan</button>
        </div>
        <div className="grow" />
        {mode === '3d' && (
          <>
            <button
              className={`btn small ${showMeasure ? 'on' : 'ghost'}`}
              title="metre grid and dimensions — for placing structure and judging scale"
              onClick={() => setShowMeasure(!showMeasure)}
            >
              measure
            </button>
            <button
              className={`btn small ${showBand ? 'on' : 'ghost'}`}
              title="dummy band figures for scale (native previz window: press M)"
              onClick={() => setShowBand(!showBand)}
            >
              band
            </button>
            <Fader label="beam viz" width={110} value={hazeViz} onChange={setHazeViz} def={0.7} variant="dim" />
          </>
        )}
        {mode === '2d' && (
          <>
            {fxSel.length > 0 && (
              <button className="btn" onClick={createGroupFromSelection} title="Create a group from the selected fixtures (appears in the Fixtures tab)">
                ⊕ group from {fxSel.length} selected
              </button>
            )}
            <select
              className="sel"
              value=""
              title="add a dummy musician — drag to place in the plan, double-click to remove"
              onChange={(e) => {
                if (e.target.value) addMusician(e.target.value);
                e.target.value = '';
              }}
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
              title="draw the stage — drag to place in the plan, double-click to remove"
              onChange={(e) => {
                if (e.target.value) addStructure(e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">+ structure…</option>
              <option value="trussBar">truss bar</option>
              <option value="trussLeg">truss leg</option>
              <option value="riser">riser</option>
              <option value="screen">screen</option>
            </select>
            <div className="seg">
              <button className={view2d === 'plan' ? 'on' : ''} onClick={() => setView2d('plan')}>Plan</button>
              <button className={view2d === 'front' ? 'on' : ''} onClick={() => setView2d('front')}>Front</button>
            </div>
            <span className="label">
              {view2d === 'plan'
                ? 'drag to place · ⌥-drag rotate · ⇧-click / drag-box select'
                : 'drag to set height · ⇧-click / drag-box select'}
            </span>
          </>
        )}
      </div>
      <div className="previzview">{mode === '3d' ? <Previz3D /> : <Previz2D />}</div>
      {/* The audition. Only present when something is selected, so the live view
          keeps the whole column the rest of the time — and the second render
          costs nothing when nobody is looking at a look. */}
      {sel && (
        <>
          <div className="previzbar previewbar">
            <span className="label">preview</span>
            <span className="previewname">{selName ?? 'empty cell'}</span>
            <span className="label dim">not on the rig</span>
          </div>
          <div className="previzview previewview">
            {mode === '3d' ? <Previz3D source="preview" /> : <Previz2D source="preview" />}
          </div>
        </>
      )}
    </>
  );
}
