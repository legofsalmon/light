import React, { useEffect, useRef, useState } from 'react';
import type { ControlLink, Layer, LayerBlend, LayerSnap, Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { notify, pageCells, pageColumns, useStore, writePage } from '../store.ts';
import { askChoice, askConfirm, askPrompt } from '../dialog.tsx';
import { LONG_PRESS_MS, contextPress } from '../touch.ts';

/** A finger wobbles on a hold; a scroll travels. Same slop touch.ts uses. */
const HOLD_SLOP = 8;
import { size } from '../tokens.ts';
import { registerShortcutActions } from '../shortcuts.ts';

/** Below this grid-area width the layer head is its narrow 96px (design 2.2).
 *  Not a token yet: the design names the number and no size/* for it. */
const NARROW_HEAD_BELOW = 1200;
import { Fader, fmtPct } from './Fader.tsx';
import { lookFace, lookSwatch } from '../lookColors.ts';
import { Face } from './library/face.tsx';
import { placeArmed, useEditingDeckId, useLibraryStore } from '../libraryStore.ts';
import { REMOTE_PAGE_COLS, useRemote } from '../remoteStore.ts';
import { useLocked } from '../lockStore.ts';
import { HeldChip } from './HeldChip.tsx';
import { openSetup } from './AdminModal.tsx';
import { APC_COLS, APC_KNOB_BANKS, APC_LAYER_ROWS } from '../apcFeedback.ts';

/** Drop from the look library: point this cell at an existing pool look.
 *  The engine only syncs deck cells on switch-away, so the active deck's stored
 *  copy is mirrored here too — same reasoning as editColumns below. */
function placeLook(layerId: string, col: number, lookId: string, deckId: string | null) {
  const st = useStore.getState();
  // The pool can change under a drag that takes seconds (another operator
  // pruning looks). Re-check at drop time, and say so — a drop that silently
  // does nothing reads as a broken grid.
  if (!st.project || !Object.hasOwn(st.project.looks, lookId)) {
    notify('that look no longer exists — the library changed mid-drag');
    return;
  }
  // A (layerId, col) pair is stable across a song change but its MEANING is
  // not: an APC bank arrow or another client switching decks mid-drag would
  // land this drop in whatever song is now on stage, silently replacing a pad
  // in a running show. Refuse rather than write into the wrong song.
  if (deckId !== null && st.project.activeDeckId !== deckId) {
    notify('the song changed while you were dragging — nothing was placed');
    return;
  }
  st.mutate((p) => {
    writePage(p, deckId, layerId, (cells) => { cells[col] = lookId; });
  });
  st.setSel({ layerId, col }); // the pad you just filled is what you edit next
}

const LOOK_DRAG = 'application/x-light-look';
/** The song the drag started in, carried alongside the look id. */
const DECK_DRAG = 'application/x-light-deck';
/** `layerId\tcol` when the drag STARTED on a pad rather than in the library.
 *  Its presence is the whole difference between the two gestures: the library
 *  copies a look onto a pad, a pad hands its look to another pad. */
const PAD_DRAG = 'application/x-light-pad';

/** Copy the look on a pad into a new, independent look on the next free pad in
 *  the same layer.
 *
 *  A pad points at a look in a shared pool, so putting the same look on two
 *  pads is referencing, not copying — edit one and both change. This is the
 *  other thing, and the one you cannot get any other way: a real copy to take
 *  somewhere else without touching the original.
 */
function duplicatePad(layerId: string, col: number, columns: number, deckId: string | null) {
  const st = useStore.getState();
  const project = st.project;
  if (!project) return;
  const layer = project.layers.find((l) => l.id === layerId);
  const cells = pageCells(project, deckId, layerId);
  const srcId = cells[col] ?? null;
  if (!srcId || !Object.hasOwn(project.looks, srcId)) {
    notify('that pad is empty');
    return;
  }
  // Nearest free pad in the same layer, looking right first because that is
  // the direction a set is built in, then left.
  const free = (() => {
    for (let c = col + 1; c < columns; c++) if (!cells[c]) return c;
    for (let c = col - 1; c >= 0; c--) if (!cells[c]) return c;
    return -1;
  })();
  if (free < 0) {
    notify(`${layer?.name ?? 'that layer'} has no free pad in this song — add a column, or clear one first`);
    return;
  }
  const id = uid('look');
  st.mutate((p) => {
    const src = p.looks[srcId];
    if (!src) return;
    // Fresh ids all the way down, the way the FX pool copies an effect. The
    // soft-override map is keyed on (lookId, partId) so a shared part id would
    // not actually collide, but two looks carrying the same part ids is the
    // kind of thing that only bites later.
    const copy = structuredClone(src);
    for (const part of copy.parts) {
      part.id = uid('part');
      for (const fx of part.effects) fx.id = uid('fx');
    }
    p.looks[id] = { ...copy, id, name: `${src.name} copy` };
    writePage(p, deckId, layerId, (cells) => { cells[free] = id; });
  }, 'duplicate a look');
  st.setSel({ layerId, col: free });
}

/** Where a copy would land on a layer: this column if it is free, else the
 *  first free one to its right. null when the layer is full. */
function hitPad(cells: (string | null)[], col: number, columns: number): number | null {
  if (!cells[col]) return col;
  for (let c = col + 1; c < columns; c++) if (!cells[c]) return c;
  return null;
}

/** Copy a look onto the top layer as a flash, ready to be turned into a hit.
 *
 *  The short path to a strobe hit — tick STROBE, tick FLASH — silently edits
 *  the wash on every pad in every song that points at it, because a pad points
 *  at a look in a shared pool. The safe path was eleven steps: duplicate (which
 *  lands on the SAME layer), rename, set flash, set strobe, set the rate, untick
 *  colour, untick dimmer, drag it to a layer that blends brightest, set the
 *  blend, check the audition. This is the first four of those in one verb, and
 *  it leaves the wash alone.
 */
function flashCopy(srcId: string, layerId: string, col: number, deckId: string | null) {
  const st = useStore.getState();
  const id = uid('look');
  st.mutate((p) => {
    const src = p.looks[srcId];
    if (!src) return;
    const copy = structuredClone(src);
    for (const part of copy.parts) {
      part.id = uid('part');
      for (const fx of part.effects) fx.id = uid('fx');
    }
    // A flash look is held, not fired, so a column press skips it — which is
    // what makes it a hit rather than a cue.
    p.looks[id] = { ...copy, id, name: `${src.name} · hit`, flash: true };
    writePage(p, deckId, layerId, (cells) => { cells[col] = id; });
  }, 'duplicate a look as a flash');
  st.setSel({ layerId, col });
}

/** Point the same pad position at this look in every song (design A20).
 *
 *  A blinder or a blackout cue wants to be under the same thumb all night, and
 *  the only way to get that was to rebuild it song by song. One look id written
 *  into one position in every song: they are the same look, so editing any of
 *  them edits all of them, which is the point. */
function putInEverySong(layerId: string, col: number) {
  const st = useStore.getState();
  const project = st.project;
  if (!project) return;
  const layer = project.layers.find((l) => l.id === layerId);
  const lookId = layer?.cells[col] ?? null;
  if (!lookId) {
    notify('that pad is empty');
    return;
  }
  const songs = project.decks ?? [];
  if (songs.length < 2) {
    notify('there is only one song');
    return;
  }
  st.mutate((p) => {
    for (const deck of p.decks ?? []) {
      const cells = (deck.cells[layerId] ??= []);
      while (cells.length <= col) cells.push(null);
      cells[col] = lookId;
    }
    // the active song's cells live on the layers, and are the copy that plays
    const ly = p.layers.find((l) => l.id === layerId);
    if (ly) {
      while (ly.cells.length <= col) ly.cells.push(null);
      ly.cells[col] = lookId;
    }
  }, 'put a look on this pad in every song');
  notify(`on this pad in all ${songs.length} songs — undo puts it back`, true);
}

/** Move a look from one pad to another, swapping if the destination is taken.
 *
 *  Swap rather than replace: rearranging a set is the reason to drag at all,
 *  and a replace would quietly drop the other look out of the song. Nothing is
 *  destroyed either way — looks live in a shared pool — but "where did that go"
 *  mid-build is exactly the confusion this is meant to remove.
 */
function movePad(from: { layerId: string; col: number }, toLayerId: string, toCol: number, deckId: string | null) {
  const st = useStore.getState();
  if (!st.project) return;
  if (from.layerId === toLayerId && from.col === toCol) return; // dropped on itself
  // Same guard as placeLook: a (layerId, col) pair keeps its meaning only
  // while the song does. An APC bank arrow or another client switching songs
  // mid-drag would move a pad in whatever is now on stage.
  if (deckId !== null && st.project.activeDeckId !== deckId) {
    notify('the song changed while you were dragging — nothing was moved');
    return;
  }
  st.mutate((p) => {
    let moving: string | null = null;
    let landing: string | null = null;
    writePage(p, deckId, from.layerId, (cells) => { moving = cells[from.col] ?? null; });
    if (!moving) return;
    writePage(p, deckId, toLayerId, (cells) => { landing = cells[toCol] ?? null; cells[toCol] = moving; });
    writePage(p, deckId, from.layerId, (cells) => { cells[from.col] = landing; });
  }, 'move a look to another pad');
  st.setSel({ layerId: toLayerId, col: toCol });
}

// Live layer state reaches a cell as three primitives, not the LayerSnap
// object — that object is freshly parsed 20×/s, so passing it re-rendered every
// cell on every snapshot even when nothing on stage moved. As primitives, the
// memo below sees no change while a look plays steadily (fadeT stays 1), and
// only the cells of a layer that is actually crossfading re-render, briefly.
const Cell = React.memo(function Cell({
  layer,
  col,
  lookId,
  liveLookId,
  liveCol,
  fadeT,
  editing,
}: {
  layer: Layer;
  col: number;
  /** what this pad holds ON THE PAGE BEING SHOWN — which is not the live page
   *  while another song is being built */
  lookId: string | null;
  liveLookId: string | null;
  liveCol: number | null;
  fadeT: number;
  /** the page being shown is not the one on stage: nothing here fires */
  editing: boolean;
}) {
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);
  const learnMode = useStore((s) => s.learnMode);
  const learnTarget = useStore((s) => s.learnTarget);
  const send = useStore((s) => s.send);
  const setSel = useStore((s) => s.setSel);

  // hasOwn, not a bare index: a cell holding "constructor" or "toString"
  // resolves to a function off the prototype and renders as a phantom look
  const look = lookId && Object.hasOwn(project.looks, lookId) ? project.looks[lookId] : null;
  const active = !!lookId && liveLookId === lookId && liveCol === col;
  const fading = active && fadeT < 1;
  const selected = sel?.layerId === layer.id && sel?.col === col;
  const armed =
    !!learnTarget && learnTarget.kind === 'cell' && learnTarget.layerId === layer.id && learnTarget.col === col;
  // This cell's column is what the layer is playing, but not this look — the
  // engine keeps the look captured at trigger time across a project edit, so
  // after a drop here the OLD look is still on stage until the pad is re-fired.
  // Left unmarked, the grid would show nothing playing while the rig is lit.
  // Only a pad that HOLDS a look can be stale: an empty pad in the live column
  // is the ordinary "layer keeps playing" case, and telling the operator to
  // fire it would be advice the empty-pad handler deliberately refuses to take.
  const staleLive = !active && !!look && liveCol === col && !!liveLookId && liveLookId !== lookId;
  const liveName =
    staleLive && Object.hasOwn(project.looks, liveLookId!) ? project.looks[liveLookId!].name : null;
  // a library look hovering over this cell (drop replaces what is here).
  // Counted, not a boolean: dragleave fires when the pointer crosses into the
  // cell's own swatch/name, and WKWebView (the Tauri shell) leaves
  // relatedTarget null, so a containment test would blink the outline off.
  const dragDepth = useRef(0);
  const [dropHover, setDropHover] = useState(false);
  const endDrag = () => {
    dragDepth.current = 0;
    setDropHover(false);
  };
  // A flash look under a finger: face 1.0 and the halo, no glow — it is not
  // playing, it is being held (design 2.3). Set on the press that holds it,
  // cleared by the same release that lets it go.
  const [held, setHeld] = useState(false);
  // The stripes the face draws, and the look's first colour: the glow's colour
  // and the layer head's mini swatch both read lookSwatch[0], the rule the APC
  // LED mirror shares, so the screen and the hardware agree (design 2.3).
  const swatch = look ? lookSwatch(look, project.looks) : null;
  const face = look ? lookFace(look, project) : null;
  const editingDeckId = useEditingDeckId();
  const armedLook = useLibraryStore((s) => (s.armed ? project.looks[s.armed]?.name ?? null : null));
  // The edit latch (design 2.11): the MIDI-learn arm shape, for the pads. While
  // it is on the WHOLE pad is the select target — tap selects, hold opens the
  // menu, a tap after arming a library tile places — and nothing fires. It is
  // the same withholding an editing page does, so the two are one test here;
  // the latch may never re-enable firing on a page the room is not playing.
  const latched = useRemote((s) => s.latch);
  const inert = editing || latched;

  // One press, two inputs. An empty pad is also where you START a look — the
  // editor invites "click an empty pad to create one" — so a stray press while
  // building must NOT black out a layer that is live: selecting is enough, and
  // the deliberate stop is the ✕ on the layer head. When the layer is already
  // idle the clear is harmless and kept, so the Resolume "empty slot stops the
  // layer" reflex still works where it cannot hurt.
  const fire = () => {
    if (learnMode) {
      useStore.getState().armLearn({ kind: 'cell', layerId: layer.id, col });
      return;
    }
    if (!look) {
      if (!liveLookId) send({ type: 'clearLayer', layerId: layer.id });
      return;
    }
    send({ type: 'trigger', layerId: layer.id, col });
  };
  const release = () => {
    setHeld(false);
    // A press that could not fire has nothing to let go of: on a latched grid,
    // or a page the room is not playing, a flash pad never went down, and a
    // `release` sent anyway would end a flash somebody ELSE is holding from the
    // APC or another client.
    if (!learnMode && !inert && look?.flash) send({ type: 'release', layerId: layer.id, col });
  };

  // Right-click, or a long press on the NAME (never on the body — a long press
  // there is how a flash look is held).
  const padMenu = contextPress(() => {
    if (!look) return;
    // Where a flash copy would land: the top layer, same column if it is free,
    // otherwise the first free column to its right. Said in the menu row, so
    // the pad it will use is known before the press rather than after.
    const top = project.layers[project.layers.length - 1];
    const pageCols = pageColumns(project, editingDeckId);
    const hit = top ? hitPad(pageCells(project, editingDeckId, top.id), col, pageCols.length) : null;
    void askChoice(`${look.name} — ${layer.name}, column ${col + 1}`, [
      { value: 'duplicate', label: 'Duplicate', primary: true },
      ...(top && top.id !== layer.id && hit !== null
        ? [{ value: 'hit', label: `Duplicate as a flash on ${top.name} · column ${hit + 1}` }]
        : []),
      { value: 'everysong', label: 'Put on this pad in every song' },
      { value: 'clear', label: 'Clear pad' },
    ], {
      body:
        'Duplicate makes an independent copy on the next free pad in this layer. Two pads pointing at the SAME look change together when you edit either one; a duplicate is how you get one you can change on its own.'
        + (top && top.id !== layer.id && hit === null ? ` ${top.name} is full, so there is nowhere to put a flash copy.` : ''),
    }).then((choice) => {
      if (choice === 'duplicate') duplicatePad(layer.id, col, pageCols.length, editingDeckId);
      else if (choice === 'hit' && top && hit !== null) flashCopy(look.id, top.id, hit, editingDeckId);
      else if (choice === 'everysong') putInEverySong(layer.id, col);
      else if (choice === 'clear') {
        useStore.getState().mutate((p) => {
          writePage(p, editingDeckId, layer.id, (cells) => { cells[col] = null; });
        }, 'clear a pad');
      }
    });
  });

  return (
    <div
      className={`cell ${look ? '' : 'empty'} ${editing ? 'inert' : ''} ${active && !editing ? 'active' : ''} ${held ? 'held' : ''} ${staleLive && !editing ? 'stale' : ''} ${selected ? 'selected' : ''} ${armed ? 'learn-armed' : ''} ${dropHover ? 'droptarget' : ''}`}
      style={swatch ? { ['--pad-glow' as string]: swatch[0] } : undefined}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(LOOK_DRAG)) return;
        dragDepth.current += 1;
        setDropHover(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(LOOK_DRAG)) return;
        e.preventDefault(); // required, or the browser refuses the drop
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(PAD_DRAG) ? 'move' : 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes(LOOK_DRAG)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) endDrag();
      }}
      onDrop={(e) => {
        endDrag();
        const id = e.dataTransfer.getData(LOOK_DRAG);
        if (!id) return;
        e.preventDefault();
        // A drag that STARTED on a pad hands its look over and takes whatever
        // was here in exchange; one from the library copies onto this pad.
        const pad = e.dataTransfer.getData(PAD_DRAG);
        const deckId = e.dataTransfer.getData(DECK_DRAG) || null;
        if (pad) {
          const [layerId, c] = pad.split('\t');
          movePad({ layerId, col: Number(c) }, layer.id, col, deckId);
          return;
        }
        placeLook(layer.id, col, id, deckId);
      }}
      title={
        latched
          ? look
            ? `${look.name} — the grid is latched for editing: this selects it, and fires nothing`
            : 'empty — the grid is latched for editing, so this selects the pad'
          : staleLive
            ? `${look!.name} — “${liveName ?? 'the previous look'}” is still on stage from this column; fire this pad to swap`
            : look
              ? `${look.name} — click to fire`
              : liveLookId
                ? 'empty — click to select (layer keeps playing)'
                : 'empty — click to stop the layer'
      }
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={look ? `${look.name} — ${layer.name}, column ${col + 1}` : `empty pad — ${layer.name}, column ${col + 1}`}
      onPointerDown={(e) => {
        // Latched, or a page the room is not playing: the whole pad selects and
        // nothing fires. A tile armed in the library places from the body too —
        // the name strip is a 22px target, and with the press withheld the
        // other 50 are free to be the same one (design 2.11).
        //
        // This is also where an editing page stops firing. The head and the
        // digit keys already withheld their cue there; the body did not, which
        // left a tap on the grid firing the live song's column from a page
        // showing another song — the misfire decision 0 exists to remove.
        // Two states withhold the cue, and they are not the same state.
        //
        // LATCHED is a touch affordance: on glass a 22px name strip is too
        // small to aim at, so while the latch is on the whole pad becomes the
        // select target (design 2.11) and a hold opens its menu.
        //
        // An EDITING PAGE is decision 0, and there the body does nothing at
        // all — not even select. The body's meaning has to stay "fire, or
        // nothing"; a body that sometimes fires and sometimes selects is the
        // ambiguity the state exists to remove, and the strip beside it still
        // selects, drags and opens the menu as it always does.
        if (latched) {
          padMenu.onPointerDown?.(e);
          if (placeArmed(project, layer.id, col, editingDeckId)) return;
          setSel({ layerId: layer.id, col });
          return;
        }
        if (editing) {
          e.preventDefault();
          return;
        }
        setSel({ layerId: layer.id, col });
        if (e.button !== 0) return; // right/middle-click must never latch a flash look
        fire();
        if (look?.flash && !learnMode) {
          e.currentTarget.setPointerCapture(e.pointerId);
          setHeld(true);
        }
      }}
      // While the latch is on the body carries the pad's menu as well: a hold
      // opens it, and the press it rides on cannot have fired anything.
      onPointerMove={latched ? padMenu.onPointerMove : undefined}
      onPointerLeave={latched ? padMenu.onPointerLeave : undefined}
      onContextMenu={latched ? padMenu.onContextMenu : undefined}
      onClickCapture={latched ? padMenu.onClickCapture : undefined}
      onPointerUp={(e) => {
        if (latched) padMenu.onPointerUp?.(e);
        release();
      }}
      onPointerCancel={(e) => {
        if (latched) padMenu.onPointerCancel?.(e);
        release();
      }}
      // Keyboard: Enter or Space is the press, and letting go releases a flash
      // look — the same two moments a pointer has.
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (e.repeat || inert) return;
        setSel({ layerId: layer.id, col });
        fire();
        if (look?.flash && !learnMode) setHeld(true);
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') release();
      }}
    >
      {look && swatch && face && (
        <>
          {/* The face is a miniature of the rig, not a stripe of the look's
              colours: which groups it touches, in stage order, in their own
              colours. `lookSwatch[0]` still feeds --pad-glow and the head's
              mini swatch, because that is the rule the APC's LEDs read. */}
          <Face face={face} />
          {look.flash && (
            <div className="flashmark" title="momentary — this look holds only while the pad is held, and the layer goes back to what it was on release">
              FLASH
            </div>
          )}
          {/* Two targets in one pad, like a Resolume clip: the body fires the
              look, the name is everything that is NOT firing — select, drag to
              another pad, right-click for the menu. Selecting has to be
              possible mid-show without putting the look on stage; previously
              the only way to open a look in the editor was to run it, which is
              not a thing you can do during someone else's song.

              The drag handle is the name and not the pad for the same reason:
              the pad body fires on pointerdown, so making it draggable would
              put a look on stage every time somebody reached for it. The long
              press belongs here too — on the body it is how a flash look is
              held. */}
          <div
            className="cellname"
            draggable
            title={`${look.name} — click to select (does not fire), drag to move it to another pad, right-click for more`}
            {...padMenu}
            onDragStart={(e) => {
              e.dataTransfer.setData(LOOK_DRAG, look.id);
              e.dataTransfer.setData(DECK_DRAG, project.activeDeckId ?? '');
              e.dataTransfer.setData(PAD_DRAG, `${layer.id}\t${col}`);
              e.dataTransfer.effectAllowed = 'move';
              // hand the keyboard back to the show before the drop lands
              (document.activeElement as HTMLElement | null)?.blur();
            }}
            onPointerDown={(e) => {
              e.stopPropagation(); // the cell body below must not fire it
              // A tile armed in the library places here (design 2.7): tap the
              // tile once, then a pad's name for each pad it should go on. The
              // arm stays, so six pads are six taps and one arm.
              if (placeArmed(project, layer.id, col, editingDeckId)) return;
              setSel({ layerId: layer.id, col });
              padMenu.onPointerDown?.(e);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              padMenu.onPointerUp?.(e);
            }}
          >
            {look.steps?.length ? '⛓ ' : ''}{look.name}
          </div>
          {fading && <div className="fadebar" style={{ width: `${fadeT * 100}%` }} />}
        </>
      )}
      {/* An empty pad has no name strip to tap, so while a look is armed it
          grows one. Nothing else changes: the body still fires the empty cue
          it always fired, and the strip appears only in the one state where it
          means something — which is also how the grid shows that a placement
          is waiting. */}
      {!look && armedLook && (
        <div
          className="cellname placehere"
          title={`put ${armedLook} on this pad`}
          onPointerDown={(e) => {
            e.stopPropagation();
            placeArmed(project, layer.id, col, editingDeckId);
          }}
        >
          place here
        </div>
      )}
    </div>
  );
});

/** Blend only affects intensity — colour, pan/tilt, strobe and macros always
 *  take the upper layer's value whatever the mode says. Worth saying on hover,
 *  because "multiply" reads like it should multiply colours and it does not. */
const BLEND_HELP: Record<LayerBlend, string> = {
  normal: 'replaces — this layer replaces what is under it (intensity only)',
  multiply: 'dims — scales what is under it; can only take light away',
  htp: 'brightest — the brighter of this layer and what is under it wins; can only add light, never remove it',
};
/** the blend's one-word tag on the layer head */
const BLEND_WORD: Record<LayerBlend, string> = { normal: 'replaces', multiply: 'dims', htp: 'brightest' };
/** The head's first line names the layer the way the desk's keys do — `L1`
 *  to `L4` in text/key (design 3.2) — when the layer still has its default
 *  name; a layer the owner has named keeps its word. The full name stays in
 *  the head's help. */
export const headName = (name: string): string => name.replace(/^layer\s+(\d+)$/i, 'L$1');
const BLENDS: LayerBlend[] = ['normal', 'multiply', 'htp'];

/** The layer head (design 2.4): line 1 the name in text/key beside a ✕ that is
 *  a ghost until something is playing; line 2 the now-playing line — a mini
 *  swatch in the look's first colour and its name in tungsten, an unlit well
 *  when idle; line 3 the master. Right-click or hold the head to change the
 *  blend — a build-time control does not belong on the performance row, so it
 *  lives behind the gesture columns and songs already use.
 *
 *  The blend rides the idle now-playing line rather than line 1. In a 120px
 *  head a real layer name ("Strobe") and the longest blend word ("brightest")
 *  want ~100px between them and there is ~84px to share, so both ellipsed —
 *  the design's own wireframe assumed the default `L1`..`L4` names. The name
 *  is what you steer by, so it keeps line 1 whole; the blend takes the empty
 *  line below, which is exactly the layer that is not doing anything and so
 *  the one you are most likely setting up. */
function LayerHead({ layer, live }: { layer: Layer; live: LayerSnap | undefined }) {
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const project = useStore((s) => s.project)!;
  const touch = useStore((s) => s.touch);
  // The grid scrolls and looks fire from MIDI/OSC too, so the active cell can
  // be off-screen. The layer head never scrolls — it is the one place that can
  // always answer "what is this layer doing right now".
  const liveId = live?.lookId ?? null;
  const liveLook = liveId && Object.hasOwn(project.looks, liveId) ? project.looks[liveId] : null;
  const crossfading = !!liveLook && (live?.t ?? 1) < 1;
  // The hold that clears a layer on glass. Deliberately not contextPress: that
  // opens a menu on a long press and lets the click through, and this must do
  // the opposite — the press itself is the whole gesture, and a short one does
  // nothing at all.
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFrom = useRef<{ x: number; y: number } | null>(null);
  const endHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdFrom.current = null;
    setHolding(false);
  };
  const clearHold = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      holdFrom.current = { x: e.clientX, y: e.clientY };
      setHolding(true);
      holdTimer.current = setTimeout(() => {
        endHold();
        if (!useStore.getState().armLearn({ kind: 'layerClear', layerId: layer.id })) {
          send({ type: 'clearLayer', layerId: layer.id });
        }
      }, LONG_PRESS_MS);
    },
    // A finger that travels is a scroll, not a hold: cancel and let the ring
    // restart on the next press rather than filling on an abandoned one.
    onPointerMove: (e: React.PointerEvent) => {
      const from = holdFrom.current;
      if (!from) return;
      if (Math.abs(e.clientX - from.x) > HOLD_SLOP || Math.abs(e.clientY - from.y) > HOLD_SLOP) endHold();
    },
    onPointerUp: endHold,
    onPointerCancel: endHold,
  };
  const blendMenu = contextPress(() => {
    void askChoice(`${layer.name} — blend`, BLENDS.map((b) => ({
      value: b,
      label: BLEND_WORD[b],
      primary: b === layer.blend,
    })), {
      body: 'How this layer combines with the layers under it. Blend only affects intensity — colour, position and strobe always take the upper layer’s value.',
    }).then((choice) => {
      const blend = BLENDS.find((b) => b === choice);
      if (!blend || blend === layer.blend) return;
      mutate((p) => {
        const l = p.layers.find((x) => x.id === layer.id);
        if (l) l.blend = blend;
      }, `set ${layer.name} to ${BLEND_WORD[blend]}`);
    });
  });
  return (
    <div className={`layerhead ${liveLook ? 'live' : ''}`}>
      <div className="row">
        <div
          className="row grow headline"
          title={`${layer.name} · ${BLEND_HELP[layer.blend]}. ${touch ? 'Hold' : 'Right-click'} to change the blend`}
          {...blendMenu}
        >
          <div className="name grow">{headName(layer.name)}</div>
        </div>
        <button
          className={`btn small ghost clearbtn ${holding ? 'holding' : ''}`}
          title={
            touch
              ? liveLook
                ? 'hold to clear this layer — it stops what it is playing, and a tap beside it on glass is not deliberate enough for that'
                : 'hold to clear this layer — nothing is playing on it'
              : liveLook ? 'clear layer — stops what it is playing' : 'clear layer — nothing is playing on it'
          }
          // On glass this is a hold, with a ring that fills over the same
          // --motion-hold the timer counts: no gesture may darken a layer by
          // accident, and a thumb resting on a 24px key beside a pad is an
          // accident waiting for a chance. The laptop's click is unchanged,
          // and so are the APC's scene buttons.
          {...(touch ? clearHold : {})}
          onClick={touch ? undefined : () => {
            if (!useStore.getState().armLearn({ kind: 'layerClear', layerId: layer.id })) {
              send({ type: 'clearLayer', layerId: layer.id });
            }
          }}
        >
          ✕
        </button>
      </div>
      <div
        className={`nowplaying ${liveLook ? 'on' : ''} ${crossfading ? 'fading' : ''}`}
        role={liveLook && live?.col != null ? 'button' : undefined}
        tabIndex={liveLook && live?.col != null ? 0 : undefined}
        title={
          liveLook
            ? `playing: ${liveLook.name}${live?.col != null ? ` (column ${live.col + 1}) — click to edit what is on stage, without firing anything` : ''}`
            : 'nothing playing on this layer'
        }
        // Select what this layer is playing (design A6, Eos's Select Active).
        // The live pad can be scrolled out of the grid or in another song's
        // page; the head always knows where it is, and selecting is not firing.
        onClick={() => {
          if (liveLook && live?.col != null) useStore.getState().setSel({ layerId: layer.id, col: live.col });
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          if (liveLook && live?.col != null) useStore.getState().setSel({ layerId: layer.id, col: live.col });
        }}
      >
        {liveLook ? (
          <>
            {/* the first colour only — the rule the APC LED mirror reads */}
            <span className="swatch mini">
              <i style={{ background: lookSwatch(liveLook, project.looks)[0] }} />
            </span>
            <span className="grow ellip">{liveLook.name}</span>
          </>
        ) : (
          <span className="blendtag" {...blendMenu}>{BLEND_WORD[layer.blend]}</span>
        )}
      </div>
      <Fader
        help={`${layer.name} master — scales everything this layer puts out. Double-click for full`}
        value={layer.master}
        onChange={(v) => send({ type: 'setLayerMaster', layerId: layer.id, v })}
        def={1}
        variant="dim"
        learn={{ kind: 'layerMaster', layerId: layer.id }}
      />
    </div>
  );
}

function DeckBar() {
  const project = useStore((s) => s.project)!;
  const remote = useRemote((s) => s.remote);
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const flushProjectWrite = useStore((s) => s.flushProjectWrite);
  const touch = useStore((s) => s.touch);
  const decks = project.decks ?? [];
  const anyPlaying = useStore((s) => (s.snap?.layers ?? []).some((l) => !!l.lookId));
  const [picker, setPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [filter, setFilter] = useState('');
  const pickerBoxRef = useRef<HTMLDivElement>(null);
  const editingDeckId = useStore((s) => s.editingDeckId);
  const setEditingDeckId = useStore((s) => s.setEditingDeckId);
  const editingSong = decks.find((d) => d.id === editingDeckId) ?? null;
  const [editPicker, setEditPicker] = useState(false);
  const [editPos, setEditPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const editBoxRef = useRef<HTMLDivElement>(null);
  const active = decks.find((d) => d.id === project.activeDeckId);
  /** the song's place in the set, so the list reads like a set list */
  const songNo = (d: { id: string } | undefined) => {
    const i = d ? decks.findIndex((x) => x.id === d.id) : -1;
    return i < 0 ? '—' : String(i + 1).padStart(2, '0');
  };
  const shown = filter.trim()
    ? decks.filter((d) => d.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : decks;
  useEffect(() => {
    if (!editPicker) return;
    const close = (e: PointerEvent) => {
      if (editBoxRef.current && !editBoxRef.current.contains(e.target as Node)) setEditPicker(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [editPicker]);
  useEffect(() => {
    if (!picker) return;
    const close = (e: PointerEvent) => {
      if (pickerBoxRef.current && !pickerBoxRef.current.contains(e.target as Node)) setPicker(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [picker]);
  type Song = (typeof decks)[number];
  const renameSong = (d: Song) => {
    void (async () => {
      const name = await askPrompt('Rename song', d.name);
      if (!name) return;
      mutate((p) => {
        const dk = p.decks?.find((x) => x.id === d.id);
        if (dk) dk.name = name;
      });
    })();
  };
  const moveSong = (d: Song, by: -1 | 1) => {
    mutate((p) => {
      const arr = p.decks ?? [];
      const i = arr.findIndex((x) => x.id === d.id);
      const j = i + by;
      if (i >= 0 && j >= 0 && j < arr.length) [arr[i], arr[j]] = [arr[j], arr[i]];
    });
  };
  const deleteSong = (d: Song) => {
    void (async () => {
      const ok = await askConfirm(`Delete song "${d.name}"?`, {
        body: 'Its pad layout is lost. The looks themselves are kept in the pool.',
        confirmLabel: 'Delete song',
        danger: true,
      });
      if (!ok) return;
      mutate((p) => {
        p.decks = (p.decks ?? []).filter((x) => x.id !== d.id);
      });
    })();
  };
  // Everything the chip's hover and double-click offer, as a menu: the touch
  // route (a long-press) and the right-click reach it too (review M15).
  const songMenu = (d: Song) => {
    const i = decks.findIndex((x) => x.id === d.id);
    const active = d.id === project.activeDeckId;
    void askChoice(
      `Song · ${d.name}`,
      [
        { value: 'rename', label: 'Rename…', primary: true },
        ...(i > 0 ? [{ value: 'earlier', label: 'Move earlier' }] : []),
        ...(i < decks.length - 1 ? [{ value: 'later', label: 'Move later' }] : []),
        ...(decks.length > 1 && !active ? [{ value: 'delete', label: 'Delete song', danger: true }] : []),
      ],
      active && decks.length > 1 ? { body: 'The song that is playing cannot be deleted — switch to another one first.' } : {},
    ).then((choice) => {
      if (choice === 'rename') renameSong(d);
      else if (choice === 'earlier') moveSong(d, -1);
      else if (choice === 'later') moveSong(d, 1);
      else if (choice === 'delete') deleteSong(d);
    });
  };
  /** Make a song, and land on it only when the room is not watching.
   *
   *  `+ song` used to create the song AND switch to it immediately — mid-set
   *  that repaints the grid and the APC's whole LED page to an empty song
   *  while the previous one is still lighting the room. Building the next song
   *  is not a live action, so it no longer takes one: with something playing
   *  the song is made and left waiting, and the notice offers the switch. */
  const addSong = async (kind: 'empty' | 'copy') => {
    const id = uid('deck');
    mutate((p) => {
      p.decks ??= [];
      if (kind === 'copy') {
        const src = p.decks.find((d) => d.id === p.activeDeckId);
        p.decks.push({
          id,
          name: `${src?.name ?? 'Song'} copy`,
          columns: [...p.columns],
          // the live layer cells ARE the active song — copy those
          cells: Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]])),
        });
      } else {
        p.decks.push({ id, name: `Song ${p.decks.length + 1}`, columns: [...p.columns], cells: {} });
      }
    });
    if (anyPlaying) {
      notify(`${kind === 'copy' ? 'copied' : 'added'} — it is waiting in the set list, and the room is unchanged`, true);
      return;
    }
    // The engine must SEE the new song before we ask it to switch — the project
    // write is throttled, and a switchDeck racing ahead of it is silently
    // dropped (unknown song). Flush the write first, then switch.
    flushProjectWrite();
    send({ type: 'switchDeck', deckId: id });
  };

  if (decks.length === 0) return null;

  /** The song that is playing, as one chip with the whole set list behind
   *  it. On the remote it sits between the two step keys, which is where a
   *  thumb reads it: the design's own song row (2.11). */
  const songChip = (
    <>
    {/* One chip for the song that is playing, not twenty in a strip that
        scrolled with its scrollbar hidden. Song 15 from song 1 was fourteen
        live presses of ▶, each one a real switch of the room; it is now one
        gesture in a list (design 2.5). */}
    <div ref={pickerBoxRef} style={{ position: 'relative', flex: '0 0 auto' }}>
      <button
        className="deckchip on songnow"
        aria-haspopup="listbox"
        aria-expanded={picker}
        title={`${active?.name ?? 'song'} — click for the whole set list · ${touch ? 'hold' : 'right-click'} to rename, move or delete`}
        {...contextPress(() => { if (active) songMenu(active); })}
        onClick={() => {
          const r = pickerBoxRef.current?.getBoundingClientRect();
          if (r) setPickerPos({ top: r.bottom + 2, left: r.left });
          setFilter('');
          setPicker((o) => !o);
        }}
      >
        {songNo(active)} · {active?.name ?? '—'} ▾
      </button>
      {picker && (
        <div className="popover songpicker" style={{ top: pickerPos.top, left: pickerPos.left }} role="listbox">
          <input
            className="text"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the click that opened it asked for the caret
            autoFocus
            placeholder="find a song"
            aria-label="find a song"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setPicker(false); return; }
              if (e.key !== 'Enter') return;
              const hit = shown[0];
              if (hit && hit.id !== project.activeDeckId) send({ type: 'switchDeck', deckId: hit.id });
              setPicker(false);
            }}
          />
          {shown.map((d) => (
            <button
              key={d.id}
              className={`btn small ghost ${d.id === project.activeDeckId ? 'on' : ''}`}
              role="option"
              aria-selected={d.id === project.activeDeckId}
              style={{ justifyContent: 'flex-start' }}
              title={d.id === project.activeDeckId ? 'this song is playing' : `switch the room to ${d.name} — the pads change under your hands`}
              onClick={() => {
                if (d.id !== project.activeDeckId) send({ type: 'switchDeck', deckId: d.id });
                setPicker(false);
              }}
            >
              {songNo(d)} · {d.name}
            </button>
          ))}
          {shown.length === 0 && <div className="prose" style={{ padding: 'var(--space-6)' }}>nothing called “{filter}”</div>}
        </div>
      )}
    </div>
    </>
  );

  return (
    <div className="deckbar" role="tablist" aria-label="songs">
      {!remote && <span className="label">song</span>}
      <button
        className="btn small ghost"
        title="previous song ( [ )"
        disabled={decks.length < 2}
        onClick={() => {
          const i = decks.findIndex((x) => x.id === project.activeDeckId);
          const n = decks.length;
          // clamp, don't wrap — matches deck_step in both engines
          const j = Math.max(0, (i < 0 ? 0 : i) - 1);
          if (j !== i) send({ type: 'switchDeck', deckId: decks[j].id });
        }}
      >
        ◀
      </button>
      {remote && songChip}
      <button
        className="btn small ghost"
        title="next song ( ] )"
        disabled={decks.length < 2}
        onClick={() => {
          const i = decks.findIndex((x) => x.id === project.activeDeckId);
          const n = decks.length;
          const j = Math.min(n - 1, (i < 0 ? 0 : i) + 1);
          if (j !== i) send({ type: 'switchDeck', deckId: decks[j].id });
        }}
      >
        ▶
      </button>
      {!remote && songChip}
      {!remote && decks.length > 1 && (() => {
        const i = decks.findIndex((x) => x.id === project.activeDeckId);
        const j = Math.min(decks.length - 1, (i < 0 ? 0 : i) + 1);
        // at the last song there is no next — stepping clamps, so saying
        // "next: <song 1>" would promise a wrap that no longer happens
        if (j === i) return null;
        return (
          <span className="decknext" title="what ] / the APC bank ▶ will select next">
            next: {decks[j].name}
          </span>
        );
      })()}
      {/* The page you are building, which is not the page the room is seeing
          (design 2.5). Picking another song here shows its pads for editing and
          leaves the rig exactly where it is; Escape, or a song switch from any
          source, comes back. Both this and `+ song` are build-time controls,
          so the remote's song row does without them and keeps the held chip in
          the width they were using (design 2.11). */}
      {!remote && (
      <div ref={editBoxRef} style={{ position: 'relative', flex: '0 0 auto' }}>
        <button
          className={`btn small ${editingDeckId ? 'warn on' : 'ghost'}`}
          aria-haspopup="listbox"
          aria-expanded={editPicker}
          title={
            editingDeckId
              ? 'the grid is showing another song’s pads — nothing on it reaches the rig. Escape comes back to what is playing.'
              : 'build another song’s pads while this one plays — nothing you do there reaches the rig'
          }
          onClick={() => {
            const r = editBoxRef.current?.getBoundingClientRect();
            if (r) setEditPos({ top: r.bottom + 2, left: r.left });
            setEditPicker((o) => !o);
          }}
        >
          editing: {editingDeckId ? songNo(editingSong ?? undefined) + ' · ' + (editingSong?.name ?? '') : 'this song'} ▾
        </button>
        {editPicker && (
          <div className="popover songpicker" style={{ top: editPos.top, left: editPos.left }} role="listbox">
            <button
              className={`btn small ghost ${editingDeckId === null ? 'on' : ''}`}
              style={{ justifyContent: 'flex-start' }}
              title="show the pads the room is seeing"
              onClick={() => { setEditingDeckId(null); setEditPicker(false); }}
            >
              this song — what is playing
            </button>
            <div className="popover-rule" />
            {decks.filter((d) => d.id !== project.activeDeckId).map((d) => (
              <button
                key={d.id}
                className={`btn small ghost ${d.id === editingDeckId ? 'on' : ''}`}
                role="option"
                aria-selected={d.id === editingDeckId}
                style={{ justifyContent: 'flex-start' }}
                title={`show ${d.name}'s pads for editing — the rig keeps playing what it is playing`}
                onClick={() => { setEditingDeckId(d.id); setEditPicker(false); }}
              >
                {songNo(d)} · {d.name}
              </button>
            ))}
          </div>
        )}
      </div>
      )}
      {!remote && (
        <button
          className="btn small ghost"
          style={{ flex: '0 0 auto' }} /* a shrinking key wraps its word and grows the song row */
          title={
            anyPlaying
              ? 'add a song — it is made and left waiting, because the room is playing something'
              : 'add a song — nothing is playing, so it opens on the new one'
          }
          onClick={() => { void addSong('empty'); }}
        >
          + song ▾
        </button>
      )}
      {/* What is standing between the show and the room, beside the song it is
          holding it away from. It draws nothing when nothing is held. */}
      {remote && <HeldChip />}
    </div>
  );
}

/** The control row — the grid's fifth row, and the APC40 mk2's fifth.
 *
 *  Named Controls are neither looks nor effects: they sit OUTSIDE the grid and
 *  reach into it, each link writing a soft override onto one look-part-field.
 *  That made them invisible from the surface you perform on — they lived in a
 *  tab, while their live positions are transient state ALL STOP wipes.
 *
 *  So they get a row of their own, ruled off from the layers above it: four
 *  layer rows plus this one is exactly the 5 x 8 clip grid of an APC40 mk2, so
 *  what is on screen is what is under your hands.
 */
/** A link reaches nothing when its look, part or effect is gone — or when the
 *  look became a cue list, which has no parts to fan onto. Same test as the
 *  Controls tab's link rows; kept here so the row can warn without opening it. */
function linkIsDead(project: Project, link: ControlLink): boolean {
  const look = Object.hasOwn(project.looks, link.lookId) ? project.looks[link.lookId] : undefined;
  if (!look || look.steps?.length) return true;
  const part = look.parts.find((p) => p.id === link.partId);
  if (!part) return true;
  return link.effectId !== undefined && !part.effects.some((e) => e.id === link.effectId);
}

/** What the operator's hardware calls this control, read from the mappings that
 *  actually exist — never from what a preset would have created. `CC 16` on its
 *  own is noise; `KNOB 1` is the thing under their hand, so device-knob CCs get
 *  named. Multiple banks of the same knob collapse to one label. */
function midiLabel(project: Project, controlId: string): { text: string; partial: boolean } | null {
  const hits = (project.midi ?? []).filter(
    (m) => m.action.kind === 'control' && m.action.controlId === controlId,
  );
  if (hits.length === 0) return null;
  // Banks per knob, not just which knobs. The APC's [TRACK SELECTION] buttons
  // move the device knobs across nine MIDI channels, so a knob bound on only
  // some of them works until someone presses a track button and then silently
  // does nothing. A learn binds exactly the one bank the surface happened to be
  // in — the preset binds all nine — and collapsing both to "knob 3" would hide
  // precisely the difference that decides whether it survives the gig.
  const banks = new Map<number, Set<number>>();
  const others: string[] = [];
  for (const m of hits) {
    if (m.type === 'cc' && m.number >= 0x10 && m.number <= 0x17) {
      const knob = m.number - 0x10 + 1;
      if (!banks.has(knob)) banks.set(knob, new Set());
      banks.get(knob)!.add(m.channel);
    } else others.push(m.type === 'cc' ? `CC ${m.number}` : `note ${m.number}`);
  }
  const partial = [...banks.values()].some((set) => set.size < APC_KNOB_BANKS);
  const parts = [
    ...[...banks.keys()].sort((a, b) => a - b).map((n) => `knob ${n}`),
    ...new Set(others),
  ];
  return { text: parts.join(' · '), partial };
}

/** Group levels: pull a whole group down without touching a look.
 *
 *  A row rather than a panel because that is how it is used — one hand, mid
 *  song, without leaving the pads. Only groups that exist are shown, and the
 *  row is absent entirely on a show with none.
 *
 *  These are runtime-only and never saved (backlog decision 4), which the
 *  header says out loud: a fader that silently persisted at zero would be a
 *  rig that came up dark next time with nothing on screen explaining why. */
function SubmasterRow() {
  const project = useStore((s) => s.project)!;
  const remote = useRemote((s) => s.remote);
  const send = useStore((s) => s.send);
  const subs = useStore((s) => s.snap?.submasters);
  const groups = project.groups;
  if (groups.length === 0) return null;
  const levelOf = (id: string) => subs?.find((x) => x.id === id)?.v ?? 1;
  const anyDown = groups.some((g) => levelOf(g.id) < 1);

  return (
    <div className="controlrow groupsrow">
      <div className="layerhead controlhead">
        <div className="row">
          {/* 48px of head holds one short word, which is the word the design
              draws there (2.11); the desk keeps the whole one. */}
          <div className="name grow">{remote ? 'GRPS' : 'GROUPS'}</div>
          {anyDown && (
            <button
              className="btn small ghost"
              title="put every group level back to full"
              onClick={() => {
                for (const g of groups) if (levelOf(g.id) < 1) send({ type: 'setSubmaster', groupId: g.id, v: 1 });
              }}
            >
              all up
            </button>
          )}
        </div>
        <div className="prose">
          Levels — not saved with the show
        </div>
      </div>
      <div className="substrip">
        {groups.map((g) => {
          const v = levelOf(g.id);
          return (
            <div key={g.id} className={`subcell ${v < 1 ? 'down' : ''}`}>
              {/* the name rides inside the fader, the way a layer master's
                  does: one line per group, so the row keeps to 2.2's height */}
              <Fader
                label={g.name}
                value={v}
                def={1}
                help={`${g.name} level — scales intensity for every head in the group. The lowest group level over a head wins, so a head in two groups follows whichever is further down.`}
                onChange={(x) => send({ type: 'setSubmaster', groupId: g.id, v: x })}
                width="100%"
                variant="dim"
                learn={{ kind: 'submaster', groupId: g.id }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ControlRow() {
  const project = useStore((s) => s.project)!;
  const live = useStore((s) => s.snap?.controls);
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const setTab = useStore((s) => s.setTab);
  const setView = useStore((s) => s.setView);
  const controls = project.controls ?? [];
  // One slot per hardware pad in the row, so control 3 is always the third pad
  // whether or not controls 1 and 2 exist yet. On the remote the row follows
  // the page the pads are on — four dials under four pads, dial 5 to 8 on the
  // page that holds column 5 to 8 — and each keeps its own slot number.
  const remote = useRemote((s) => s.remote);
  const page = useRemote((s) => s.page);
  const locked = useLocked();
  const all = Array.from({ length: APC_COLS }, (_, i) => controls[i] ?? null);
  const first = remote ? Math.min(page, Math.max(0, Math.ceil(APC_COLS / REMOTE_PAGE_COLS) - 1)) * REMOTE_PAGE_COLS : 0;
  const slots = remote ? all.slice(first, first + REMOTE_PAGE_COLS) : all;

  // Appends, and only the NEXT free slot offers it — clicking the last slot to
  // get a control there would otherwise have to invent every control in
  // between, and an unlinked control is a live macro that reaches nothing.
  const addControl = () =>
    mutate((p) => {
      p.controls ??= [];
      p.controls.push({
        id: uid('ctl'),
        name: `Control ${p.controls.length + 1}`,
        value: 0,
        links: [],
      });
    });

  // One grid item spanning every track, not APC_COLS loose cells: the grid's
  // template has 1 + columns.length + 1 tracks, so a fixed eight would spill
  // into a second row on any song without exactly eight columns and scatter
  // live macro faders through the wrong tracks. The bank is eight because the
  // hardware row is eight; it lays itself out inside.
  return (
    <div className="controlrow">
      <div className="layerhead controlhead">
        <div className="row">
          <div className="name grow">{remote ? 'DIAL' : 'DIALS'}</div>
          <button
            className="btn small ghost"
            title="open the Controls tab — where a dial's links, brackets and pulses are edited"
            onClick={() => {
              setView('split');
              setTab('controls');
            }}
          >
            edit
          </button>
        </div>
        <div className="prose">
          Dials — tweak whatever is playing
        </div>
      </div>
      {slots.map((c, k) => {
        const i = first + k;
        if (!c) {
          // The one slot that can be filled — and only where editing is
          // allowed at all: on a locked client an empty slot is an empty slot.
          const next = i === controls.length && !locked;
          return (
            <div
              key={`empty-${i}`}
              className={`cell ctlcell empty ${next ? 'addable' : ''}`}
              title={next
                ? 'add a control — then link it to parameters in the Controls tab'
                : 'empty control slot — controls fill left to right, eight to match the APC40 device knobs'}
              onClick={next ? addControl : undefined}
            >
              {next && <div className="ctladd">+</div>}
            </div>
          );
        }
        const liveValue = live?.find((x) => x.id === c.id)?.value;
        const riding = liveValue !== undefined && liveValue !== c.value;
        // No links at all, or every link pointing at something that no longer
        // exists: either way the fader moves and the rig does not.
        const deadLinks = c.links.filter((l) => linkIsDead(project, l)).length;
        const dangling = c.links.length === 0 || deadLinks === c.links.length;
        const midi = midiLabel(project, c.id);
        return (
          <div
            key={c.id}
            className={`cell ctlcell ${riding ? 'riding' : ''}`}
            title={
              c.links.length === 0
                ? `${c.name} — no links yet, so it reaches nothing. Add links in the Controls tab.`
                : dangling
                  ? `${c.name} — every one of its ${c.links.length} links points at a look, part or effect that is gone. It reaches nothing.`
                  : `${c.name} — ${c.links.length} link${c.links.length > 1 ? 's' : ''}${deadLinks ? `, ${deadLinks} dangling` : ''}${riding ? ' · live, not stored' : ''}`
            }
          >
            <div className="ctlname">
              {(dangling || deadLinks > 0) && <span className="ctlwarn">⚠ </span>}
              {c.name}
            </div>
            <Fader
              help={`${c.name} — moving this is a nudge: live, not stored. Keep in the top bar writes it into the look`}
              value={liveValue ?? c.value}
              def={c.value}
              onChange={(v) => send({ type: 'setControl', controlId: c.id, value: v })}
              fmt={fmtPct}
              learn={{ kind: 'control', controlId: c.id }}
              variant="dim"
            />
            {midi && (
              <div
                className={`ctlmidi ${midi.partial ? 'partial' : ''}`}
                title={
                  midi.partial
                    ? `driven by ${midi.text}, but only on some of the APC's track-selection banks — press a track button and it stops responding. Re-load the APC40 preset to bind every bank.`
                    : `driven by ${midi.text}`
                }
              >
                {midi.partial ? `${midi.text} ⚠` : midi.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Where the eye is when the rig stays dark: above the pads, not in a tooltip
 *  (review M3). A pad lights the stage; if nothing reaches the rig, say why here
 *  — and say what to do about it. Gone the moment an output is on. */
/** Why the rig is dark, as the grid's own corner chip (design #17, P6).
 *
 *  This was a full-width paragraph above the pads — 50 px, a fifth of the Build
 *  grid, on screen at every rehearsal because LIGHT boots offline by design and
 *  the sentence therefore always applied. The sentence itself is said in four
 *  places already (the gate button, the output dot, the Output tab's banner and
 *  the setup guide); what only this one had was the verb. So the verb moves to
 *  the grid's empty top-left label cell, where it costs no row at all, and the
 *  explaining is left to the gate. */
function RigChip() {
  const project = useStore((s) => s.project)!;
  const setView = useStore((s) => s.setView);
  const send = useStore((s) => s.send);
  const noFixtures = project.fixtures.length === 0;
  const noOutput = !project.universes.some((u) => u.artnet || u.sacn);
  // The third way a pad can light the stage and nothing else: universes are
  // set up, but LIGHT has not been told to transmit. It is the one of the
  // three that looks like a fault, so it gets the go-live button right here
  // rather than a trip to another tab.
  const offline = useStore((s) => s.snap?.transmit) !== true;
  // The fourth: everything is set up and going out, but the rig is repeating a
  // frame on purpose. Freezing and forgetting is the failure mode — you walk
  // away believing the show is following the pads — so it says so where the
  // pads are, not only in the top bar.
  const frozen = useStore((s) => s.snap?.frozen) === true;
  if (!noFixtures && !noOutput && !offline && !frozen) return null;
  return (
    <button
      className={`btn small gridchip ${!noFixtures && !noOutput ? 'warn on' : 'ghost'}`}
      title={
        noFixtures
          ? 'Nothing is patched yet — pads light the stage, but there is no rig for them to reach. Add fixtures in the Rig view.'
          : noOutput
            ? 'Outputs are off — the stage shows what the rig would do, and nothing reaches it. Turn on Art-Net or sACN in the Output tab when you want it live.'
            : offline
              ? 'LIGHT is offline — the stage shows what the rig would do, and nothing reaches it. The universes are set up, so this is the only step left.'
              : 'The rig is held on one frame. Everything here is still running and the stage view is following it — the room is not.'
      }
      onClick={() => {
        if (noFixtures) setView('patch');
        else if (noOutput) openSetup('output');
        else if (offline) send({ type: 'setTransmit', v: true });
        else send({ type: 'setFreeze', v: false });
      }}
    >
      {noFixtures ? 'no rig yet →' : noOutput ? 'outputs off →' : offline ? 'go live ▸' : 'release hold'}
    </button>
  );
}

export function LookGrid() {
  const project = useStore((s) => s.project)!;
  const liveLayers = useStore((s) => s.snap?.layers);
  const learnMode = useStore((s) => s.learnMode);
  const touch = useStore((s) => s.touch);
  const learnTarget = useStore((s) => s.learnTarget);
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  // Latched, nothing in the grid fires — the heads withhold their cue exactly
  // the way a page the room is not playing does, and select instead.
  const latched = useRemote((s) => s.latch);

  // The page being shown: the room's, or another song's while it is being built
  // (design 2.5). Everything below reads through it — the columns, every pad,
  // and every write — so the grid can show song B while song A is on stage.
  const editingDeckId = useStore((s) => s.editingDeckId);
  const setEditingDeckId = useStore((s) => s.setEditingDeckId);
  const editingSong = (project.decks ?? []).find((d) => d.id === editingDeckId) ?? null;
  const editing = editingSong !== null;
  const cols = pageColumns(project, editingDeckId);
  const songLabel = editingSong
    ? `${String(((project.decks ?? []).findIndex((d) => d.id === editingSong.id) + 1)).padStart(2, '0')} · ${editingSong.name}`
    : '';
  // On an editing page the column heads and keys 1-9 select rather than fire,
  // so the grid needs somewhere to show which column that was.
  const [selCol, setSelColRaw] = useState<number | null>(null);
  const setSelCol = (col: number) => {
    setSelColRaw(col);
    gridRef.current?.querySelectorAll('.colhead')[col]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  useEffect(() => { if (!editing && !latched) setSelColRaw(null); }, [editing, latched]);
  // The digit keys need somewhere to put their selection on a page that does
  // not fire; the table names the action, this owns it.
  useEffect(() => {
    registerShortcutActions({ selectColumn: (col) => { if (col < cols.length) setSelCol(col); } });
  }, [cols.length]);
  // Four columns at a time on the remote, behind a two-position key (design
  // 2.11). The pads on screen are a WINDOW on the song's columns, never a
  // renumbering of them: every head, pad and dial below keeps its real column
  // index, so what a page fires is what the desk would fire.
  const remote = useRemote((s) => s.remote);
  const page = useRemote((s) => s.page);
  const setPage = useRemote((s) => s.setPage);
  const pages = remote ? Math.max(1, Math.ceil(cols.length / REMOTE_PAGE_COLS)) : 1;
  const pageIdx = Math.min(page, pages - 1);
  const firstCol = remote ? pageIdx * REMOTE_PAGE_COLS : 0;
  const shownCols = remote ? cols.slice(firstCol, firstCol + REMOTE_PAGE_COLS) : cols;
  // The head row IS the pager: a native scroll container with mandatory
  // snapping, so the browser cancels the click that follows a pan itself and
  // no swipe can leave a trailing click on a head that fires a column. There
  // is no JS pointer pager here on purpose — that is the misfire the page key
  // exists to remove.
  const pagerRef = useRef<HTMLDivElement>(null);
  const scrolledPage = useRef(0);
  const onPagerScroll = () => {
    const el = pagerRef.current;
    if (!el) return;
    const p = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    scrolledPage.current = p;
    if (p !== pageIdx) setPage(p);
  };
  useEffect(() => {
    const el = pagerRef.current;
    // Already there, or a finger is taking it there: a correction mid-snap
    // would cut the browser's own animation short. Only the page key moves it.
    if (!el || scrolledPage.current === pageIdx) return;
    el.scrollLeft = pageIdx * el.clientWidth; // no slides on the grid, ever (design 3.4)
    scrolledPage.current = pageIdx;
  }, [pageIdx, remote, cols.length]);
  // The layer head narrows from 120 to 96 when the grid area is under 1,200px
  // (design 2.2), so a panel opening at 1280 narrows the head rather than
  // pushing the pads below their floor. Measured on the wrapper the grid
  // scrolls in — its content box is the grid area the design budgets.
  const gridRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const wrap = gridRef.current?.parentElement;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? wrap.clientWidth;
      setNarrow(w < NARROW_HEAD_BELOW);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  // Top of stack first. `layers` is only how many rows sit ABOVE the control
  // row — the grid and an APC40 mk2 are then the same shape (4 layer rows + the
  // control row = its 5 x 8 clip grid). Older shows really do carry a fifth
  // layer, so the rest are rendered under the control row rather than hidden: a
  // layer you cannot see is a layer still lighting the stage.
  //
  // Every EDIT must still walk `allLayers`. Splicing a column through the
  // capped list alone would leave the fifth layer's cells one short of
  // `columns`, silently shifting every pad on it — and the misalignment is
  // copied into the stored deck and autosaved.
  const allLayers = [...project.layers].reverse();
  // In Build the grid is a context row, not the grid: a tab strip to pick the
  // layer, the column heads, and that one layer's pads. Four layer rows plus
  // the dial and group rows left the editor 260px at 1440 and no pad row at all
  // at 1024 — the editor is what Build is for (design #42, B1).
  const compact = useStore((s) => s.view) === 'split';
  const sel = useStore((s) => s.sel);
  const [tabLayerId, setTabLayerId] = useState<string | null>(null);
  // The selection leads: clicking a pad in Build should keep its own layer on
  // screen. The tab is the fallback for when nothing is selected.
  const shownId = (sel && allLayers.some((l) => l.id === sel.layerId) ? sel.layerId : null)
    ?? (tabLayerId && allLayers.some((l) => l.id === tabLayerId) ? tabLayerId : null)
    ?? allLayers[0]?.id
    ?? null;
  const capped = allLayers.slice(0, APC_LAYER_ROWS);
  const layers = compact ? allLayers.filter((l) => l.id === shownId) : capped;
  const overflowLayers = compact ? [] : allLayers.slice(APC_LAYER_ROWS);

  /** Column edits touch three places that must stay the same length: the live
   *  columns, every layer's cells, and the active deck's stored copy of both.
   *  The engine only syncs the deck when you switch away, so doing it here
   *  keeps a saved show consistent even if you never leave the song. */
  // Columns are per song, so this edits the page on screen. On the live page
  // that is the layers plus the song's stored mirror; on any other it is that
  // song's own arrays, which the engine will not read until it loads them.
  const editColumns = (fn: (cols: string[], cellsOf: (layerId: string) => (string | null)[]) => void) =>
    mutate((p) => {
      const live = editingDeckId === null || editingDeckId === p.activeDeckId;
      if (live) {
        const cellArrays = new Map(p.layers.map((l) => [l.id, l.cells]));
        fn(p.columns, (id) => cellArrays.get(id)!);
        const deck = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
        if (deck) {
          deck.columns = [...p.columns];
          deck.cells = Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]]));
        }
        return;
      }
      const deck = (p.decks ?? []).find((d) => d.id === editingDeckId);
      if (!deck) return;
      for (const l of p.layers) deck.cells[l.id] ??= [];
      fn(deck.columns, (id) => (deck.cells[id] ??= []));
    });

  const renameColumn = (col: number) => {
    void askPrompt(`Rename column ${col + 1}`, cols[col] ?? '', {
      body: 'Column names are per song — naming them after the song’s sections is the point.',
      confirmLabel: 'Rename',
    }).then((name) => {
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      editColumns((c) => {
        c[col] = trimmed;
      });
    });
  };

  const insertColumn = (after: number) => {
    editColumns((c, cellsOf) => {
      c.splice(after + 1, 0, `Col ${c.length + 1}`);
      for (const l of allLayers) cellsOf(l.id).splice(after + 1, 0, null);
    });
  };

  const deleteColumn = (col: number) => {
    const filled = allLayers.filter((l) => l.cells[col]).length;
    void askConfirm(`Delete column ${col + 1}${cols[col] ? ` · ${cols[col]}` : ''}?`, {
      body:
        filled > 0
          ? `${filled} pad(s) in this column will be emptied in this song. The looks themselves stay in the pool.`
          : 'The column is empty.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      editColumns((c, cellsOf) => {
        c.splice(col, 1);
        for (const l of allLayers) cellsOf(l.id).splice(col, 1);
      });
    });
  };

  const columnMenu = (col: number, name: string) => {
    void askChoice(`Column ${col + 1}${name ? ` · ${name}` : ''}`, [
      { value: 'rename', label: 'Rename…', primary: true },
      { value: 'insert', label: 'Insert column after' },
      ...(cols.length > 1
        ? [{ value: 'delete', label: 'Delete column', danger: true }]
        : []),
    ]).then((choice) => {
      if (choice === 'rename') renameColumn(col);
      else if (choice === 'insert') insertColumn(col);
      else if (choice === 'delete') deleteColumn(col);
    });
  };

  // What each column head has to say, from state the grid already holds: which
  // layers keep a pad there, and which of those are playing it (design A23 —
  // the playback bar every desk has and this grid did not). `all` is the
  // hardware's own rule: the APC mini lights a column button only when every
  // layer holding content there is playing it (surfaces.ts).
  const colStates = cols.map((name, col) => {
    const holding = allLayers.filter((l) => l.cells[col]);
    const playing = holding.filter((l) => {
      const live = liveLayers?.find((x) => x.id === l.id);
      return live?.col === col && live.lookId === l.cells[col];
    });
    const t = playing.reduce((min, l) => {
      const live = liveLayers?.find((x) => x.id === l.id);
      return Math.min(min, live?.t ?? 1);
    }, 1);
    const has = holding.length > 0;
    const all = has && playing.length === holding.length;
    const some = playing.length > 0;
    return {
      has,
      t,
      cls: `${all ? 'live' : some ? 'part' : ''}`,
      what: has
        ? `${all ? 'playing' : some ? 'partly playing' : 'fire'} column ${col + 1}${name ? ` · ${name}` : ''}${col < 9 ? ` (key ${col + 1})` : ''}`
        : `column ${col + 1}${name ? ` · ${name}` : ''} is empty — firing it clears every layer${col < 9 ? ` (key ${col + 1})` : ''}`,
    };
  });

  /** The grid's one-line chip. Empty unless it has something to say: the learn
   *  prompt while learn is armed, otherwise the one verb that would put light
   *  on the rig (design #17). On the remote it rides the page-key row, because
   *  the grid's own first track is 48px of layer head there. */
  const gridLabel = (
    <div className="gridlabel label">
      {learnMode
        ? (learnTarget ? 'move a control…' : 'click a target…')
        : latched
          ? (
            // A state that withholds cues has to be readable from the grid
            // itself, not only from the key that armed it — on a laptop the
            // wash is otherwise the only thing that says why a pad went quiet
            // (section 8, rule 18). Clicking it drops the latch; it is a chip
            // that can only STOP a mode, never start a cue.
            <button
              className="btn small gridchip warn on"
              title="the grid is latched for editing: a tap selects a pad, a hold opens its menu, and nothing here fires. Click, or press E, to let it play again."
              onClick={() => useRemote.getState().setLatch(false)}
            >
              latched · E
            </button>
          )
        : editing
          ? (
            <button
              className="btn small gridchip warn on"
              title={`These are ${songLabel}'s pads. ${project.decks?.find((d) => d.id === project.activeDeckId)?.name ?? 'another song'} is playing, and nothing here reaches the rig — press Escape to come back to it.`}
              onClick={() => setEditingDeckId(null)}
            >
              editing {songLabel.slice(0, 2)} · Esc
            </button>
          )
          : <RigChip />}
    </div>
  );

  /** One column head. The same element in both layouts — a track of the grid on
   *  a desk, and a child of the pager on the remote — so the one thing it does
   *  on a left click is written once. */
  const columnHead = (col: number) => {
    const name = cols[col] ?? '';
    const inert = editing || latched;
    return (
      <div
        key={col}
        className={`colhead ${inert ? 'inert' : colStates[col].cls} ${inert && selCol === col ? 'selcol' : ''} ${learnTarget?.kind === 'column' && learnTarget.col === col ? 'learn-armed' : ''}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.currentTarget.click(); } }}
        title={
          editing
            ? `select column ${col + 1}${name ? ` · ${name}` : ''} · editing ${songLabel} — fires only on the song that is playing`
            : latched
              ? `select column ${col + 1}${name ? ` · ${name}` : ''} — the grid is latched for editing, so nothing here fires`
              : `${colStates[col].what} · ${touch ? 'hold' : 'right-click'} to rename, insert or delete`
        }
        onClick={() => {
          // On an editing page a column head selects its column rather than
          // firing it — the room is playing another song, and a head that
          // fired the live page from a grid showing a different one is the
          // ambiguity decision 0 removes. The latch withholds it for the same
          // reason: while it is on, nothing in the grid fires.
          if (inert) {
            setSelCol(col);
            return;
          }
          if (!useStore.getState().armLearn({ kind: 'column', col })) send({ type: 'column', col });
        }}
        // Right-click or a long-press, never a left click: a left click fires
        // the column, so editing must not be reachable by the gesture that
        // triggers cues. The hold is the tablet's right-click (review M15).
        {...contextPress(() => columnMenu(col, name))}
      >
        {/* What firing it will do, before you fire it: ▶ when some layer holds
            a pad here, ■ when none does — an all-empty column clears every
            layer, which is a cue in its own right and used to look exactly
            like a column that would light the room. */}
        {!inert && <span className="colmark" aria-hidden="true">{colStates[col].has ? '▶' : '■'}</span>}
        {col + 1} · {name}
        {/* the crossfade running into this column, on the head that fired it */}
        {!editing && colStates[col].t < 1 && (
          <i className="colfade" style={{ width: `${Math.round(colStates[col].t * 100)}%` }} aria-hidden="true" />
        )}
      </div>
    );
  };

  return (
    <>
    {/* Build shows one layer at a time, so changing which one is a tap rather
        than a trip back to Pads: editing the top layer's strobe while Layer 1
        is selected never leaves the view (design 2.6). */}
    {compact && (
      <div className="layertabs" role="tablist" aria-label="layer">
        {allLayers.map((l) => (
          <button
            key={l.id}
            className={`btn small ${l.id === shownId ? 'on' : 'ghost'}`}
            role="tab"
            aria-selected={l.id === shownId}
            title={`${l.name} — show this layer's pads`}
            onClick={() => {
              setTabLayerId(l.id);
              // A tab without a selection on it would snap straight back, since
              // the selection leads: move the selection with the tab.
              const first = l.cells.findIndex((c) => c);
              useStore.getState().setSel({ layerId: l.id, col: first < 0 ? 0 : first });
            }}
          >
            {headName(l.name)}
          </button>
        ))}
      </div>
    )}
    <DeckBar />
    {/* The page key: two positions, like the bank arrows. Tapping one is the
        route that cannot misfire; the swipe is the pager's own. */}
    {remote && (
      <div className="remotekeys">
        {gridLabel}
        {pages > 1 && (
          <div className="pagekey" role="group" aria-label="page">
            {Array.from({ length: pages }, (_, p) => {
              const from = p * REMOTE_PAGE_COLS + 1;
              const to = Math.min(cols.length, (p + 1) * REMOTE_PAGE_COLS);
              return (
                <button
                  key={p}
                  className={`btn small ${p === pageIdx ? 'on' : 'ghost'}`}
                  aria-pressed={p === pageIdx}
                  title={`show columns ${from}–${to} — the pads change under your thumb and nothing fires`}
                  onClick={() => setPage(p)}
                >
                  {from}–{to}
                </button>
              );
            })}
          </div>
        )}
      </div>
    )}
    {remote && (
      <div className="pagerrow">
        {/* the head column's width, so the heads land over their own pads */}
        <div />
        <div className="colpager" ref={pagerRef} onScroll={onPagerScroll}>
          {Array.from({ length: pages }, (_, p) => (
            <div
              key={p}
              className="colpage"
              style={{ gridTemplateColumns: `repeat(${REMOTE_PAGE_COLS}, minmax(0, 1fr))` }}
            >
              {cols
                .slice(p * REMOTE_PAGE_COLS, (p + 1) * REMOTE_PAGE_COLS)
                .map((_, i) => columnHead(p * REMOTE_PAGE_COLS + i))}
            </div>
          ))}
        </div>
      </div>
    )}
    <div
      ref={gridRef}
      className={`lookgrid ${narrow ? 'narrow' : ''} ${compact ? 'compact' : ''} ${editing ? 'editingpage' : ''}`}
      // Head + N pad tracks + the add column, from the tokens: each pad track
      // flexes between its floor and its ceiling so eight columns fill the grid
      // area at every window from the Tauri floor up, and the grid scrolls
      // sideways only once the pads are at their floor (design 2.2).
      //
      // On the remote it is the 48px head and four tracks with a floor of zero,
      // and no add column: a head plus four pads has four gaps, and the pad
      // floor and the add column together are 30px more than a 390px phone
      // holds. Four `minmax(0, 1fr)` tracks in a grid that is `width: 100%`
      // cannot overflow their wrapper, whatever the window (design 2.11).
      style={{
        gridTemplateColumns: remote
          ? `var(--size-layerhead-w) repeat(${shownCols.length}, minmax(0, 1fr))`
          : `var(--size-layerhead-w) repeat(${cols.length}, minmax(var(--size-pad-w-min), var(--size-pad-w-max))) var(--size-addcol-w)`,
      }}
    >
      {/* The grid's one-line chip, and the heads. On the remote both are
          rendered above the grid instead — the chip beside the page key, the
          heads inside the pager that pages it. */}
      {!remote && gridLabel}
      {!remote && cols.map((_, col) => columnHead(col))}
      {/* The trailing add-column track is an edit affordance, and the remote
          is locked out of it — so it is not rendered there, which is also the
          30px the row cannot afford (design 2.11). */}
      {!remote && (
        <div
          className="colhead addcol"
          title="add a column to this song"
          onClick={() => insertColumn(cols.length - 1)}
        >
          +
        </div>
      )}
      {layers.map((layer) => {
        const live = liveLayers?.find((l) => l.id === layer.id);
        // primitives, not the freshly-parsed LayerSnap object, so a memoized
        // cell only re-renders when its own live state actually changes
        const liveLookId = live?.lookId ?? null;
        const liveCol = live?.col ?? null;
        const fadeT = live?.t ?? 1;
        const cells = pageCells(project, editingDeckId, layer.id);
        return (
          <React.Fragment key={layer.id}>
            {/* the head always reads the room, whatever page the pads show */}
            <LayerHead layer={layer} live={live} />
            {shownCols.map((_, i) => {
              const col = firstCol + i;
              return (
                <Cell key={col} layer={layer} col={col} lookId={cells[col] ?? null} liveLookId={liveLookId} liveCol={liveCol} fadeT={fadeT} editing={editing} />
              );
            })}
            {/* grid auto-flow is continuous, so every row must fill the
                add-column track or the next layer head slides up into it.
                There is no such track on the remote, and no filler either. */}
            {!remote && <div className="gridfiller" />}
          </React.Fragment>
        );
      })}
      {/* The fifth row. Ruled off from the layers because it is not one: these
          reach into whatever is playing rather than playing anything. Both are
          performance rows, so Build does without them. */}
      {!compact && <ControlRow />}
      {!compact && <SubmasterRow />}
      {overflowLayers.map((layer) => {
        const live = liveLayers?.find((l) => l.id === layer.id);
        const cells = pageCells(project, editingDeckId, layer.id);
        return (
          <React.Fragment key={layer.id}>
            <LayerHead layer={layer} live={live} />
            {shownCols.map((_, i) => {
              const col = firstCol + i;
              return (
                <Cell
                  key={col}
                  layer={layer}
                  col={col}
                  lookId={cells[col] ?? null}
                  editing={editing}
                  liveLookId={live?.lookId ?? null}
                  liveCol={live?.col ?? null}
                  fadeT={live?.t ?? 1}
                />
              );
            })}
            {!remote && <div className="gridfiller" />}
          </React.Fragment>
        );
      })}
    </div>
    </>
  );
}
