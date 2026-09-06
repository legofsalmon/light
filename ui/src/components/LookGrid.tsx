import React, { useEffect, useRef, useState } from 'react';
import type { ControlLink, Layer, LayerBlend, LayerSnap, Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { notify, useStore } from '../store.ts';
import { askChoice, askConfirm, askPrompt } from '../dialog.tsx';
import { contextPress } from '../touch.ts';
import { size } from '../tokens.ts';
import { Fader } from './Fader.tsx';
import { lookSwatch } from '../lookColors.ts';
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
    const l = p.layers.find((x) => x.id === layerId);
    if (!l) return;
    while (l.cells.length < col) l.cells.push(null); // never leave holes for JSON to invent
    l.cells[col] = lookId;
    const deck = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
    if (deck) deck.cells = Object.fromEntries(p.layers.map((x) => [x.id, [...x.cells]]));
  });
  st.setSel({ layerId, col }); // the pad you just filled is what you edit next
}

const LOOK_DRAG = 'application/x-light-look';
/** The song the drag started in, carried alongside the look id. */
const DECK_DRAG = 'application/x-light-deck';

// Live layer state reaches a cell as three primitives, not the LayerSnap
// object — that object is freshly parsed 20×/s, so passing it re-rendered every
// cell on every snapshot even when nothing on stage moved. As primitives, the
// memo below sees no change while a look plays steadily (fadeT stays 1), and
// only the cells of a layer that is actually crossfading re-render, briefly.
const Cell = React.memo(function Cell({
  layer,
  col,
  liveLookId,
  liveCol,
  fadeT,
}: {
  layer: Layer;
  col: number;
  liveLookId: string | null;
  liveCol: number | null;
  fadeT: number;
}) {
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);
  const learnMode = useStore((s) => s.learnMode);
  const learnTarget = useStore((s) => s.learnTarget);
  const send = useStore((s) => s.send);
  const setSel = useStore((s) => s.setSel);

  const lookId = layer.cells[col] ?? null;
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
    if (!learnMode && look?.flash) send({ type: 'release', layerId: layer.id, col });
  };

  return (
    <div
      className={`cell ${look ? '' : 'empty'} ${active ? 'active' : ''} ${staleLive ? 'stale' : ''} ${selected ? 'selected' : ''} ${armed ? 'learn-armed' : ''} ${dropHover ? 'droptarget' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(LOOK_DRAG)) return;
        dragDepth.current += 1;
        setDropHover(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(LOOK_DRAG)) return;
        e.preventDefault(); // required, or the browser refuses the drop
        e.dataTransfer.dropEffect = 'copy';
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
        placeLook(layer.id, col, id, e.dataTransfer.getData(DECK_DRAG) || null);
      }}
      title={
        staleLive
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
        setSel({ layerId: layer.id, col });
        if (e.button !== 0) return; // right/middle-click must never latch a flash look
        fire();
        if (look?.flash && !learnMode) e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      // Keyboard: Enter or Space is the press, and letting go releases a flash
      // look — the same two moments a pointer has.
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (e.repeat) return;
        setSel({ layerId: layer.id, col });
        fire();
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') release();
      }}
    >
      {look && (
        <>
          <div className="swatch">
            {lookSwatch(look, project.looks).map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </div>
          {look.flash && (
            <div className="flashmark" title="momentary — this look holds only while the pad is held, and the layer goes back to what it was on release">
              FLASH
            </div>
          )}
          {/* Two targets in one pad, like a Resolume clip: the body fires the
              look, the name selects it for editing without firing. Selecting
              has to be possible mid-show without putting the look on stage —
              previously the only way to open a look in the editor was to run
              it, which is not a thing you can do during someone else's song. */}
          <div
            className="cellname"
            title={`${look.name} — click to select (does not fire)`}
            onPointerDown={(e) => {
              e.stopPropagation(); // the cell body below must not fire it
              setSel({ layerId: layer.id, col });
            }}
            onPointerUp={(e) => e.stopPropagation()}
          >
            {look.steps?.length ? '⛓ ' : ''}{look.name}
          </div>
          {fading && <div className="fadebar" style={{ width: `${fadeT * 100}%` }} />}
        </>
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

function LayerHead({ layer, live }: { layer: Layer; live: LayerSnap | undefined }) {
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const project = useStore((s) => s.project)!;
  // The grid scrolls and looks fire from MIDI/OSC too, so the active cell can
  // be off-screen. The layer head never scrolls — it is the one place that can
  // always answer "what is this layer doing right now".
  const liveId = live?.lookId ?? null;
  const liveLook = liveId && Object.hasOwn(project.looks, liveId) ? project.looks[liveId] : null;
  const crossfading = !!liveLook && (live?.t ?? 1) < 1;
  return (
    <div className="layerhead">
      <div className="row">
        <div className="name grow">{layer.name}</div>
        {/* How this layer combines with the layers below. It was a read-only
            chip, which meant the only way to change a blend was to hand-edit
            the project file. */}
        <select
          className="chip chipsel"
          value={layer.blend}
          title={BLEND_HELP[layer.blend]}
          onChange={(e) => {
            const blend = e.target.value as LayerBlend;
            mutate((p) => {
              const l = p.layers.find((x) => x.id === layer.id);
              if (l) l.blend = blend;
            });
          }}
        >
          <option value="normal">replaces</option>
          <option value="multiply">dims</option>
          <option value="htp">brightest</option>
        </select>
        <button
          className="btn small ghost clearbtn"
          title="clear layer"
          onClick={() => {
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
        title={
          liveLook
            ? `playing: ${liveLook.name}${live?.col != null ? ` (column ${live.col + 1})` : ''}`
            : 'nothing playing on this layer'
        }
      >
        {liveLook ? (
          <>
            <span className="swatch mini">
              {lookSwatch(liveLook, project.looks).map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
            <span className="grow ellip">{liveLook.name}</span>
          </>
        ) : (
          '—'
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
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const flushProjectWrite = useStore((s) => s.flushProjectWrite);
  const touch = useStore((s) => s.touch);
  const decks = project.decks ?? [];
  const activeChipRef = useRef<HTMLDivElement>(null);
  // A chip carries both gestures: click switches the live song, double-click
  // renames. The browser delivers click, click, dblclick — so a naive handler
  // switches the whole show (grid, APC LEDs, OSC follow target) to the wrong
  // song the instant you start a rename. Hold the switch briefly; if a
  // double-click follows, cancel it. The eyes-off switch paths (APC bank
  // arrows, [ / ]) are untouched and stay instant.
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // a deck change from the APC bank arrows (or [ / ]) must bring the live
  // song on screen — with 12 songs the active chip is often scrolled away
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [project.activeDeckId]);
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
  if (decks.length === 0) return null;

  return (
    <div className="deckbar" role="tablist" aria-label="songs">
      <span className="label">song</span>
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
      {decks.map((d) => (
        <div
          key={d.id}
          ref={d.id === project.activeDeckId ? activeChipRef : undefined}
          className={`deckchip ${d.id === project.activeDeckId ? 'on' : ''}`}
          role="tab"
          aria-selected={d.id === project.activeDeckId}
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && d.id !== project.activeDeckId) { e.preventDefault(); send({ type: 'switchDeck', deckId: d.id }); }
          }}
          title={`click to switch · double-click to rename · ${touch ? 'hold' : 'right-click'} for more`}
          {...contextPress(() => songMenu(d))}
          onClick={() => {
            // already on this deck: a switch is a no-op, so don't delay the
            // rename that a double-click here is about to ask for
            if (d.id === project.activeDeckId) return;
            if (switchTimer.current) clearTimeout(switchTimer.current);
            switchTimer.current = setTimeout(() => {
              switchTimer.current = null;
              send({ type: 'switchDeck', deckId: d.id });
            }, 220);
          }}
          onDoubleClick={() => {
            if (switchTimer.current) {
              clearTimeout(switchTimer.current);
              switchTimer.current = null; // the pending switch was the first click of this double
            }
            renameSong(d);
          }}
        >
          {d.name}
          {decks.length > 1 && d.id === project.activeDeckId && (
            <>
              <span
                className="deckmove"
                title="move this song earlier"
                onClick={(e) => {
                  e.stopPropagation();
                  moveSong(d, -1);
                }}
              >
                ‹
              </span>
              <span
                className="deckmove"
                title="move this song later"
                onClick={(e) => {
                  e.stopPropagation();
                  moveSong(d, 1);
                }}
              >
                ›
              </span>
            </>
          )}
          {decks.length > 1 && d.id !== project.activeDeckId && (
            <span
              className="deckx"
              title="delete song"
              onClick={(e) => {
                e.stopPropagation();
                deleteSong(d);
              }}
            >
              ×
            </span>
          )}
        </div>
      ))}
      {decks.length > 1 && (() => {
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
      <button
        className="btn small ghost"
        title="new empty song"
        onClick={() => {
          const id = uid('deck');
          mutate((p) => {
            p.decks ??= [];
            p.decks.push({ id, name: `Song ${p.decks.length + 1}`, columns: [...p.columns], cells: {} });
          });
          // The engine must SEE the new deck before we ask it to switch — the
          // project write is throttled, and a switchDeck racing ahead of it is
          // silently dropped (unknown deck). Flush the write first, then switch.
          flushProjectWrite();
          send({ type: 'switchDeck', deckId: id }); // land on the deck you just made
        }}
      >
        + song
      </button>
      <button
        className="btn small ghost"
        title="copy this song's pads into a new song — the usual way to start the next one"
        onClick={() => {
          const id = uid('deck');
          mutate((p) => {
            p.decks ??= [];
            const src = p.decks.find((d) => d.id === p.activeDeckId);
            p.decks.push({
              id,
              name: `${src?.name ?? 'Song'} copy`,
              columns: [...p.columns],
              // the live layer cells ARE the active deck — copy those
              cells: Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]])),
            });
          });
          // flush before switching — the deck must exist on the engine first
          flushProjectWrite();
          send({ type: 'switchDeck', deckId: id });
        }}
      >
        ⧉ duplicate
      </button>
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

function ControlRow() {
  const project = useStore((s) => s.project)!;
  const live = useStore((s) => s.snap?.controls);
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const setTab = useStore((s) => s.setTab);
  const setView = useStore((s) => s.setView);
  const controls = project.controls ?? [];
  // One slot per hardware pad in the row, so control 3 is always the third pad
  // whether or not controls 1 and 2 exist yet.
  const slots = Array.from({ length: APC_COLS }, (_, i) => controls[i] ?? null);

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
          <div className="name grow">DIALS</div>
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
      {slots.map((c, i) => {
        if (!c) {
          const next = i === controls.length; // the one slot that can be filled
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
              fmt={(v) => `${Math.round(v * 100)}%`}
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
function RigHint() {
  const project = useStore((s) => s.project)!;
  const setView = useStore((s) => s.setView);
  const setTab = useStore((s) => s.setTab);
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
    <div className="gridhint">
      <span className="prose">
        {noFixtures
          ? 'Nothing is patched yet — pads light the stage, but there is no rig for them to reach. Add fixtures in the Rig view.'
          : noOutput
            ? 'Outputs are off — the stage shows what the rig would do, and nothing reaches it. Turn on Art-Net or sACN in the Output tab when you want it live.'
            : offline
              ? 'LIGHT is offline — the stage shows what the rig would do, and nothing reaches it. The universes are set up, so this is the only step left.'
              : 'The rig is held on one frame. Everything here is still running and the stage view is following it — the room is not.'}
      </span>
      <button
        className={`btn small ${!noFixtures && !noOutput ? 'warn on' : ''}`}
        onClick={() => {
          if (noFixtures) setView('patch');
          else if (noOutput) { setView('split'); setTab('output'); }
          else if (offline) send({ type: 'setTransmit', v: true });
          else send({ type: 'setFreeze', v: false });
        }}
      >
        {noFixtures ? 'Rig view' : noOutput ? 'Output tab' : offline ? 'go live' : 'release'}
      </button>
    </div>
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

  const cols = project.columns;
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
  const layers = allLayers.slice(0, APC_LAYER_ROWS);
  const overflowLayers = allLayers.slice(APC_LAYER_ROWS);

  /** Column edits touch three places that must stay the same length: the live
   *  columns, every layer's cells, and the active deck's stored copy of both.
   *  The engine only syncs the deck when you switch away, so doing it here
   *  keeps a saved show consistent even if you never leave the song. */
  const editColumns = (fn: (cols: string[], cellsOf: (layerId: string) => (string | null)[]) => void) =>
    mutate((p) => {
      const cellArrays = new Map(p.layers.map((l) => [l.id, l.cells]));
      fn(p.columns, (id) => cellArrays.get(id)!);
      const deck = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
      if (deck) {
        deck.columns = [...p.columns];
        deck.cells = Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]]));
      }
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

  return (
    <>
    <RigHint />
    <DeckBar />
    <div
      className="lookgrid"
      style={{ gridTemplateColumns: `${size['layerhead-w']}px repeat(${cols.length}, ${size['pad-w']}px) ${size['addcol-w']}px` }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        className="label"
      >
        {learnMode ? (learnTarget ? 'move a control…' : 'click a target…') : ''}
      </div>
      {cols.map((name, col) => (
        <div
          key={col}
          className={`colhead ${learnTarget?.kind === 'column' && learnTarget.col === col ? 'learn-armed' : ''}`}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.currentTarget.click(); } }}
          title={`trigger column ${col + 1}${col < 9 ? ` (key ${col + 1})` : ''} · ${touch ? 'hold' : 'right-click'} to rename, insert or delete`}
          onClick={() => {
            if (!useStore.getState().armLearn({ kind: 'column', col })) send({ type: 'column', col });
          }}
          // Right-click or a long-press, never a left click: a left click fires
          // the column, so editing must not be reachable by the gesture that
          // triggers cues. The hold is the tablet's right-click (review M15).
          {...contextPress(() => columnMenu(col, name))}
        >
          {col + 1} · {name}
        </div>
      ))}
      <div
        className="colhead addcol"
        title="add a column to this song"
        onClick={() => insertColumn(cols.length - 1)}
      >
        +
      </div>
      {layers.map((layer) => {
        const live = liveLayers?.find((l) => l.id === layer.id);
        // primitives, not the freshly-parsed LayerSnap object, so a memoized
        // cell only re-renders when its own live state actually changes
        const liveLookId = live?.lookId ?? null;
        const liveCol = live?.col ?? null;
        const fadeT = live?.t ?? 1;
        return (
          <React.Fragment key={layer.id}>
            <LayerHead layer={layer} live={live} />
            {cols.map((_, col) => (
              <Cell key={col} layer={layer} col={col} liveLookId={liveLookId} liveCol={liveCol} fadeT={fadeT} />
            ))}
            {/* grid auto-flow is continuous, so every row must fill the
                add-column track or the next layer head slides up into it */}
            <div className="gridfiller" />
          </React.Fragment>
        );
      })}
      {/* The fifth row. Ruled off from the layers because it is not one: these
          reach into whatever is playing rather than playing anything. */}
      <ControlRow />
      {overflowLayers.map((layer) => {
        const live = liveLayers?.find((l) => l.id === layer.id);
        return (
          <React.Fragment key={layer.id}>
            <LayerHead layer={layer} live={live} />
            {cols.map((_, col) => (
              <Cell
                key={col}
                layer={layer}
                col={col}
                liveLookId={live?.lookId ?? null}
                liveCol={live?.col ?? null}
                fadeT={live?.t ?? 1}
              />
            ))}
            <div className="gridfiller" />
          </React.Fragment>
        );
      })}
    </div>
    </>
  );
}
