import React from 'react';
import { uid } from '../../../shared/types.ts';
import type { StagePropKind } from '../../../shared/types.ts';
import { STRUCTURE_DEFAULTS } from '../../../shared/types.ts';
import { createGroupFromSelection } from '../selection.ts';
import { useStore } from '../store.ts';
import { Fader } from './Fader.tsx';
import { Previz2D } from './Previz2D.tsx';
import { Previz3D } from './Previz3D.tsx';

export function PrevizPanel({ preview = true }: { preview?: boolean }) {
  const view = useStore((s) => s.view);
  const togglePreviz = useStore((s) => s.togglePreviz);
  const previewPane = useStore((s) => s.previewPane);
  const togglePreviewPane = useStore((s) => s.togglePreviewPane);
  const autoExposure = useStore((s) => s.previzAutoExposure);
  const toggleAutoExposure = useStore((s) => s.togglePrevizAutoExposure);
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
  const snapToTruss = useStore((s) => s.snapToTruss);
  const setSnapToTruss = useStore((s) => s.setSnapToTruss);
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
        {/* Leftmost, and pinned out of the scrolling region: this bar scrolls
            horizontally with its scrollbar hidden, and in 2D on a narrow window
            its contents overflow — an escape hatch you cannot reach is not an
            escape hatch. Absent in the full-screen previz view, where hiding it
            would leave nothing. */}
        {view !== 'previz' && (
          <button
            className="btn small ghost pin"
            title="hide the stage (this view only — the strip left behind brings it back)"
            onClick={() => togglePreviz(view)}
          >
            ▴
          </button>
        )}
        <span className="label">stage</span>
        <div className="seg">
          <button
            className={mode === '3d' ? 'on' : ''}
            title="3D stage view — what the rig looks like from the room, with beams and haze"
            onClick={() => setMode('3d')}
          >
            3D
          </button>
          <button
            className={mode === '2d' ? 'on' : ''}
            title="2D plan — the drafting view: drag fixtures into place, snap them to truss, draw structure"
            onClick={() => setMode('2d')}
          >
            2D plan
          </button>
        </div>
        <div className="grow" />
        {/* Snap acts on 2D PLAN drags and measure drives the 2D grid, but both
            lived in the 3D-only branch — the snap button's own tooltip
            described an action impossible in the mode the button appeared in,
            and in 2D, where they apply, there was no control and no hint one
            existed. Shown in both modes now. */}
        <button
          className={`btn small ${snapToTruss ? 'on' : 'ghost'}`}
          title="2D plan: drag a fixture near a truss bar and it clamps on and rigs there — turn off to place freely"
          onClick={() => setSnapToTruss(!snapToTruss)}
        >
          snap
        </button>
        <button
          className={`btn small ${showMeasure ? 'on' : 'ghost'}`}
          title="metre grid and dimensions — for placing structure and judging scale"
          onClick={() => setShowMeasure(!showMeasure)}
        >
          measure
        </button>
        <button
          className="btn small ghost"
          title="open the stage in its own window — the native renderer, for a second screen"
          onClick={() => useStore.getState().send({ type: 'launchPreviz' })}
        >
          stage window
        </button>
        {/* The audition is a second renderer, and it appears whenever a pad is
            selected — which firing one does. Worth it while building; worth
            switching off for a show run from the pads. */}
        {preview && (
          <button
            className={`btn small ${previewPane ? 'on' : 'ghost'}`}
            title="audition pane — shows the selected look without sending it to the rig; off gives the live view the whole band"
            onClick={togglePreviewPane}
          >
            preview
          </button>
        )}
        {mode === '3d' && (
          <>
            <button
              className={`btn small ${showBand ? 'on' : 'ghost'}`}
              title="dummy band figures for scale (stage window: press M)"
              onClick={() => setShowBand(!showBand)}
            >
              band
            </button>
            <button
              className={`btn small ${autoExposure ? 'on' : 'ghost'}`}
              title="eye adaptation — the exposure follows how much light is on stage, the way your eyes do walking into a bright room. Partial, so a brighter look still reads brighter. Off holds a fixed exposure, for judging absolute levels."
              onClick={toggleAutoExposure}
            >
              auto exp
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
              <button
                className={view2d === 'plan' ? 'on' : ''}
                title="top-down: dragging a fixture sets where it stands on the floor"
                onClick={() => setView2d('plan')}
              >
                Plan
              </button>
              <button
                className={view2d === 'front' ? 'on' : ''}
                title="front elevation: dragging a fixture sets its HANG HEIGHT, not its position"
                onClick={() => setView2d('front')}
              >
                Front
              </button>
            </div>
            {/* Both hints sit in the SAME grid cell, so the box is always as wide
                as the longer one. Sized by content, the plan hint is ~72px
                longer than the front one — and because everything here is
                right-aligned behind a .grow spacer, that shoved the Plan/Front
                buttons sideways on every toggle, out from under the cursor that
                had just pressed them. Reserving the max needs no measured
                constant, so editing either string cannot quietly bring the jump
                back. */}
            <span className="label hint2d">
              <span className={view2d === 'plan' ? undefined : 'ghost'}>
                drag to place · ⌥-drag rotate · ⇧-click / drag-box select
              </span>
              <span className={view2d === 'front' ? undefined : 'ghost'}>
                drag to set height · ⇧-click / drag-box select
              </span>
            </span>
          </>
        )}
      </div>
      <div className="previzsplit">
        <div className="previzview">{mode === '3d' ? <Previz3D /> : <Previz2D />}</div>
        {/* The audition, on the band's right edge. Only present when something
            is selected, so the live view keeps the full width the rest of the
            time — and the second render costs nothing when nobody is looking
            at a look. */}
        {preview && previewPane && sel && (
          <div className="previewpane">
            <div className="previzbar previewbar">
              <span className="label">preview</span>
              <span className="previewname">{selName ?? 'empty pad'}</span>
              <span className="label dim">not on the rig</span>
            </div>
            <div className="previzview previewview">
              {mode === '3d' ? <Previz3D source="preview" /> : <Previz2D source="preview" />}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
