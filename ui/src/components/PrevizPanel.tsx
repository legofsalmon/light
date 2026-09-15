import React, { useEffect, useRef, useState } from 'react';
import { Glyph } from '../glyphs.tsx';
import { uid } from '../../../shared/types.ts';
import type { StagePropKind } from '../../../shared/types.ts';
import { STRUCTURE_DEFAULTS } from '../../../shared/types.ts';
import { createGroupFromSelection } from '../selection.ts';
import { useStore } from '../store.ts';
import { size, space } from '../tokens.ts';
import { Fader } from './Fader.tsx';
import { Previz2D } from './Previz2D.tsx';
import { Previz3D } from './Previz3D.tsx';
import '../styles/band.css';

/** The one thing the stage says about itself.
 *
 *  Every reading on this canvas is a claim about a rig somewhere else, and
 *  four states break that claim: the gate is shut, the frame is held, a light
 *  is burning at full white to be found, or the show is dark. A fifth says the
 *  pads being edited are not the pads that are playing. On the second screen
 *  there is no top bar beside the canvas to read any of it off — so it is
 *  drawn ON the canvas, top-left, one tag, and the most dangerous truth wins
 *  (design 2.8, #16). A frozen rig can never animate here unlabelled. */
export function StageTag(): React.ReactElement | null {
  const snap = useStore((s) => s.snap);
  const findName = useStore((s) => {
    const id = s.snap?.identify;
    if (!id || !s.project) return null;
    return s.project.fixtures.find((f) => f.id === id)?.name ?? null;
  });
  /** The song being edited while another one plays. The store grows the field
   *  in a later pass of this design (#26); reading it defensively lets the tag
   *  ship now and start telling the truth the moment the field lands. */
  const editingName = useStore((s) => {
    const id = (s as { editingDeckId?: string | null }).editingDeckId ?? null;
    if (!id || !s.project || id === s.project.activeDeckId) return null;
    return (s.project.decks ?? []).find((d) => d.id === id)?.name ?? null;
  });

  // Worst first: nothing is on the wire at all, then the wire is not following
  // the screen, then a light is lit that blackout cannot put out, then the
  // show is dark — and last, that this page is not the one playing.
  const tag: { tone: string; text: string; help: string } | null =
    !snap?.transmit
      ? { tone: 'warn', text: 'OFFLINE', help: 'nothing is reaching the rig — the gate is shut. The show still runs on screen, and this is what LIGHT boots as.' }
      : snap.frozen
        ? { tone: 'warn', text: 'HELD', help: 'the rig is holding the frame it was showing — the screen follows the show, the wire does not. Blackout and ALL STOP release it.' }
        : snap.identify
          ? { tone: 'find', text: `FINDING ${findName ?? 'a light'}`, help: 'a light is held at full white so you can find it — it ignores blackout, and only releasing it or ALL STOP puts it out.' }
          : snap.blackout
            ? { tone: 'hot', text: 'BLACKOUT', help: 'the show is dark — every layer is still running underneath, and clearing blackout brings it straight back.' }
            : editingName
              ? { tone: 'editing', text: `EDITING ${editingName}`, help: 'the pads on screen belong to a song that is not playing — firing one selects it instead of sending it.' }
              : null;
  if (!tag) return null;
  return (
    <div className={`label stagetag ${tag.tone}`} role="status" title={tag.help}>
      {tag.text}
    </div>
  );
}

/** How this canvas draws, off the bar.
 *
 *  Four of these were lit cyan by default on a bar that is meant to be chrome
 *  that never glows, and one of them — snap — does nothing whatever in 3D. A
 *  setting you touch while building belongs in a menu; the bar keeps what a
 *  hand reaches for mid-show (design #16, 2.8). */
function ViewMenu({ mode, preview }: { mode: '3d' | '2d'; preview: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const previewPane = useStore((s) => s.previewPane);
  const togglePreviewPane = useStore((s) => s.togglePreviewPane);
  const autoExposure = useStore((s) => s.previzAutoExposure);
  const toggleAutoExposure = useStore((s) => s.togglePrevizAutoExposure);
  const showBand = useStore((s) => s.showBand);
  const setShowBand = useStore((s) => s.setShowBand);
  const showMeasure = useStore((s) => s.showMeasure);
  const setShowMeasure = useStore((s) => s.setShowMeasure);
  const snapToTruss = useStore((s) => s.snapToTruss);
  const setSnapToTruss = useStore((s) => s.setSnapToTruss);
  const hazeViz = useStore((s) => s.hazeViz);
  const setHazeViz = useStore((s) => s.setHazeViz);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        className={`btn small ghost ${open ? 'on' : ''}`}
        title="how this canvas draws — the audition, the figures, eye adaptation and the drafting aids. None of it reaches the rig."
        onClick={() => {
          // The bar is an overflow scroll container, which would clip a menu to
          // its own height — so the popover is positioned against the viewport
          // from the key's own rectangle, the way the project menu is. This key
          // sits at the RIGHT edge of the bar, where a menu hung from its left
          // corner runs off the window, so it hangs from whichever corner keeps
          // it on screen.
          const r = btnRef.current?.getBoundingClientRect();
          if (r) {
            setPos({
              top: r.bottom + 2,
              left: Math.max(space[4], Math.min(r.left, window.innerWidth - size['menu-w'] - space[4])),
            });
          }
          setOpen((o) => !o);
        }}
      >
        view <Glyph name="chevron" />
      </button>
      {open && (
        <div className="popover viewmenu" style={{ top: pos.top, left: pos.left }}>
          {preview && (
            <button
              className={`btn small ghost ${previewPane ? 'on' : ''}`}
              title="audition — shows the selected look beside the live stage without sending it to the rig. It appears only while the selected pad holds a look its layer is not already playing."
              onClick={togglePreviewPane}
            >
              audition
            </button>
          )}
          {mode === '3d' && (
            <>
              <button
                className={`btn small ghost ${showBand ? 'on' : ''}`}
                title="dummy figures on stage for scale — nobody is really standing there (stage window: press M)"
                onClick={() => setShowBand(!showBand)}
              >
                band figures
              </button>
              <button
                className={`btn small ghost ${autoExposure ? 'on' : ''}`}
                title="eye adaptation — the exposure follows how much light is on stage, the way your eyes do walking into a bright room. Partial, so a brighter look still reads brighter. Off holds a fixed exposure, for judging absolute levels."
                onClick={toggleAutoExposure}
              >
                eye adaptation
              </button>
              <div className="popover-rule" />
              <Fader
                label="beam viz"
                help="how much haze the beams are drawn through — the picture only, never the hazer itself"
                value={hazeViz}
                onChange={setHazeViz}
                def={0.7}
                variant="dim"
              />
            </>
          )}
          {/* Snap and measure are drafting aids: snap does nothing whatever in
              3D, and it was lit there anyway. Offered where they act. */}
          {mode === '2d' && (
            <>
              <button
                className={`btn small ghost ${snapToTruss ? 'on' : ''}`}
                title="snap to truss — drag a fixture near a truss bar and it clamps on and rigs there. Off places it freely."
                onClick={() => setSnapToTruss(!snapToTruss)}
              >
                snap to truss
              </button>
              <button
                className={`btn small ghost ${showMeasure ? 'on' : ''}`}
                title="metre grid and dimensions — for placing structure and judging scale"
                onClick={() => setShowMeasure(!showMeasure)}
              >
                measure grid
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function PrevizPanel({ preview = true }: { preview?: boolean }) {
  const view = useStore((s) => s.view);
  const togglePreviz = useStore((s) => s.togglePreviz);
  const previewPane = useStore((s) => s.previewPane);
  const mode = useStore((s) => s.previzMode);
  const setMode = useStore((s) => s.setPrevizMode);
  const view2d = useStore((s) => s.previz2dView);
  const setView2d = useStore((s) => s.setPreviz2dView);
  const touch = useStore((s) => s.touch);
  const planTool = useStore((s) => s.previz2dTool);
  const setPlanTool = useStore((s) => s.setPreviz2dTool);
  const fxSel = useStore((s) => s.fxSel);
  const sel = useStore((s) => s.sel);
  const selName = useStore((s) => {
    if (!s.sel || !s.project) return null;
    const layer = s.project.layers.find((l) => l.id === s.sel!.layerId);
    const id = layer?.cells[s.sel!.col];
    return id && Object.hasOwn(s.project.looks, id) ? s.project.looks[id].name : null;
  });
  /** Whether the audition would be telling the operator anything.
   *
   *  It exists to show a look that is NOT on the rig — and firing a pad
   *  selects it, so "whenever a pad is selected" meant that mid-song the band
   *  showed the live stage beside a second render of the very look that had
   *  just gone live: two identical pictures, and a renderer's worth of GPU for
   *  the privilege. It appears now only when the selected pad holds a look its
   *  own layer is not already playing. The toggle stays the operator's enable;
   *  this is the condition underneath it (design #15). */
  const auditionDiffers = useStore((s) => {
    if (!s.sel || !s.project) return false;
    const layer = s.project.layers.find((l) => l.id === s.sel!.layerId);
    const selLook = layer?.cells[s.sel!.col] ?? null;
    if (!selLook) return false; // an empty pad has nothing to audition
    const live = s.snap?.layers.find((l) => l.id === s.sel!.layerId);
    return (live?.lookId ?? null) !== selLook;
  });
  const mutate = useStore((s) => s.mutate);

  /** The full-screen stage: a display, not a drafting surface. It is what goes
   *  on the second screen at front of house, so it carries the two view keys,
   *  the way out to the native window and the tag — and none of the drafting
   *  tools or the standing cheat-sheet that were pinned across it (2.8). */
  const stage = view === 'previz';

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
            escape hatch. Absent in the full-screen stage view, where hiding it
            would leave nothing. */}
        {!stage && (
          <button
            className="btn small ghost pin foldup"
            title="hide the stage (this view only — the strip left behind brings it back)"
            onClick={() => togglePreviz(view)}
          >
            <Glyph name="chevron" alone />
          </button>
        )}
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
            2D
          </button>
        </div>
        <div className="grow" />
        {/* The drafting tools. Not on the full-screen stage: that screen is a
            readout at front of house, and a musician picker across the top of
            it is furniture nobody at the desk can reach. */}
        {!stage && mode === '2d' && (
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
            {touch ? (
              // ⌥ and ⇧ do not exist on glass (review M15): on the tablet a
              // tool picker says what a drag does instead.
              <div className="seg" role="group" aria-label="plan tool">
                <button
                  className={planTool === 'move' || (planTool === 'rotate' && view2d !== 'plan') ? 'on' : ''}
                  title={
                    view2d === 'plan'
                      ? 'drag moves a fixture or a prop; a drag on empty space boxes a selection'
                      : 'drag sets a fixture’s hang height; a drag on empty space boxes a selection'
                  }
                  onClick={() => setPlanTool('move')}
                >
                  Move
                </button>
                {view2d === 'plan' && (
                  <button
                    className={planTool === 'rotate' ? 'on' : ''}
                    title="drag turns a fixture or a bar (snaps to 5°)"
                    onClick={() => setPlanTool('rotate')}
                  >
                    Turn
                  </button>
                )}
                <button
                  className={planTool === 'select' ? 'on' : ''}
                  title="tap adds a fixture to the selection or takes it out; a drag on empty space adds everything in the box"
                  onClick={() => setPlanTool('select')}
                >
                  Select
                </button>
              </div>
            ) : (
              <span className="label hint2d">
                <span className={view2d === 'plan' ? undefined : 'ghost'}>
                  drag to place · ⌥-drag rotate · ⇧-click / drag-box select
                </span>
                <span className={view2d === 'front' ? undefined : 'ghost'}>
                  drag to set height · ⇧-click / drag-box select
                </span>
              </span>
            )}
          </>
        )}
        <button
          className="btn small ghost"
          title="open the stage in its own window — the native renderer, for a second screen"
          onClick={() => useStore.getState().send({ type: 'launchPreviz' })}
        >
          stage window
        </button>
        {!stage && <ViewMenu mode={mode} preview={preview} />}
      </div>
      <div className="previzsplit">
        <div className="previzview">
          {mode === '3d' ? <Previz3D /> : <Previz2D />}
          <StageTag />
        </div>
        {/* The audition, on the band's right edge. Present only while the
            selected pad holds a look its layer is not already playing, so the
            live view keeps the full width the rest of the time — and the
            second render costs nothing when it would only be showing the
            operator what the stage beside it already shows. */}
        {preview && previewPane && auditionDiffers && sel && (
          <div className="previewpane">
            <div className="previzbar previewbar">
              <span className="label">audition</span>
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
