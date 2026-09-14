// One editor, two homes (the side column and the bottom panel). Top to bottom
// it is: a stripe that says whether what you are typing reaches the rig, a
// header naming the look and holding the keys that act on it, and the part
// bodies.

import React, { useState } from 'react';
import type { Look, Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { TextField } from './inputs.tsx';
import { useStore } from '../store.ts';
import { askConfirm } from '../dialog.tsx';
import { BeatsInput, FadeInput } from './editor/fields.tsx';
import { OffsetDials } from './editor/OffsetDials.tsx';
import { PartEditor } from './editor/PartEditor.tsx';
import '../styles/editor.css';

/** How many pads carry this look, and across how many songs.
 *
 *  Every song, not just the one on the grid: the look pool is shared, so a
 *  rename here is a rename in the other seven songs too and the header should
 *  say so before it is typed rather than after. The CURRENT song's pads live
 *  in `project.layers` — the stored page only syncs on a song switch — so they
 *  are counted from there and that page's stale copy is skipped. */
export function sharedBy(project: Project, lookId: string): { pads: number; songs: number } {
  const here = project.layers.reduce((n, ly) => n + ly.cells.filter((c) => c === lookId).length, 0);
  let pads = here;
  let songs = here > 0 ? 1 : 0;
  for (const d of project.decks ?? []) {
    if (d.id === project.activeDeckId) continue;
    const n = Object.values(d.cells).reduce((m, cells) => m + cells.filter((c) => c === lookId).length, 0);
    if (n > 0) {
      pads += n;
      songs += 1;
    }
  }
  return { pads, songs };
}

/** A look with every id minted fresh, so nothing it is copied from can reach
 *  it — not a dial's link, not a nudge that is riding the original. */
function copyOfLook(look: Look): Look {
  return {
    ...look,
    id: uid('look'),
    name: `${look.name} copy`,
    parts: look.parts.map((pt) => ({
      ...pt,
      id: uid('part'),
      params: { ...pt.params },
      effects: pt.effects.map((fx) => ({ ...fx, id: uid('fx') })),
    })),
  };
}

export function LookEditor() {
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const ride = useStore((s) => s.ride);
  const setRide = useStore((s) => s.setRide);
  const setView = useStore((s) => s.setView);
  const liveLayers = useStore((s) => s.snap?.layers);
  const frozen = useStore((s) => !!s.snap?.frozen);
  const [more, setMore] = useState<{ top: number; left: number } | null>(null);
  const [shared, setShared] = useState<{ top: number; left: number } | null>(null);
  const moreBtn = React.useRef<HTMLButtonElement>(null);
  const sharedBtn = React.useRef<HTMLButtonElement>(null);

  if (!sel) return <div className="hint">Select a pad to edit its look — click an empty pad to start a new one (it won't fire the layer).</div>;

  const layer = project.layers.find((l) => l.id === sel.layerId);
  if (!layer) return <div className="hint">Layer no longer exists.</div>;
  const lookId = layer.cells[sel.col] ?? null;
  // hasOwn, not a bare index: a cell id of "constructor"/"toString" resolves to
  // a function off Object's prototype (truthy), and look.parts.map below then
  // throws and takes down the whole bottom-panel Region. The grid, previz and
  // swatch code all guard this way — this reader was the one that didn't.
  const look: Look | null =
    lookId && Object.hasOwn(project.looks, lookId) ? project.looks[lookId] : null;

  if (!look || !lookId) {
    // Looks are a shared pool across songs, so filling a pad from the pool is
    // the primary authoring move — without it a new song is 32 dead pads.
    const pool = Object.values(project.looks).sort((a, b) => a.name.localeCompare(b.name));
    // A look needs a group to drive. With none, "+ create look here" made a
    // part with an empty group and every row hid — a dead end exactly where a
    // new user lands after New Project (review M8). Say what to do instead.
    if (project.groups.length === 0) {
      return (
        <div className="hint">
          <div style={{ marginBottom: 10 }}>
            Empty pad — {layer.name} · column {sel.col + 1}
          </div>
          <div className="prose" style={{ maxWidth: 420, margin: '0 auto 12px' }}>
            Nothing to light yet — a look drives a group of fixtures, and this show has none. Add
            fixtures in the Rig view and make a group; then a pad here can hold a look.
          </div>
          <button className="btn" onClick={() => setView('patch')}>Rig view</button>
        </div>
      );
    }
    return (
      <div className="hint">
        <div style={{ marginBottom: 10 }}>
          Empty pad — {layer.name} · column {sel.col + 1}
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

            title="make a new look on this pad and open it for editing — nothing fires">
            + create look here
          </button>
          <select
            className="sel"
            value=""
            disabled={pool.length === 0}
            title="put an existing look from the pool onto this pad"
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
        <div className="prose" style={{ marginTop: 8 }}>
          {pool.length} look{pool.length === 1 ? '' : 's'} in this project’s pool — the same look can sit in
          many pads and songs.
        </div>
      </div>
    );
  }

  const editLook = (fn: (lk: Look) => void, label?: string) =>
    mutate((p) => {
      const lk = p.looks[lookId];
      if (lk) fn(lk);
    }, label);

  // The stripe. Playing here means this layer is running THIS look from THIS
  // column; frozen means the wire is holding whatever it last sent, so an edit
  // that reaches the show does not reach the rig until the hold is released.
  const live = liveLayers?.find((l) => l.id === sel.layerId);
  const playing = live?.lookId === lookId && live?.col === sel.col;
  const state: 'live' | 'held' | 'off' = frozen ? 'held' : playing ? 'live' : 'off';
  const stripe = {
    live: { word: 'LIVE', caption: 'edits reach the rig now' },
    held: { word: 'HELD', caption: 'the rig is holding the frame it has — edits land when the hold is released' },
    off: { word: 'NOT ON THE RIG', caption: 'this look is not playing, so an edit waits here until it fires' },
  }[state];
  const count = sharedBy(project, lookId);

  const closeMenus = () => { setMore(null); setShared(null); };
  const openAt = (
    ref: React.RefObject<HTMLButtonElement | null>,
    set: (p: { top: number; left: number } | null) => void,
  ) => {
    closeMenus();
    const r = ref.current?.getBoundingClientRect();
    if (r) set({ top: r.bottom + 2, left: Math.max(8, r.left) });
  };

  return (
    <div className={`lookeditor ${state === 'off' ? 'blind' : ''}`}>
      <div className={`stripe ${state === 'live' ? 'live' : state === 'held' ? 'held' : ''}`}>
        <span className="lampword">{stripe.word}</span>
        <span className="prose">{stripe.caption}</span>
        <div className="grow" />
        <span className="label">{layer.name} · column {sel.col + 1}</span>
      </div>

      <div className="lookhead">
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
        <FadeInput value={look.fade} placeholder={layer.fade} onCommit={(v) => editLook((lk) => (lk.fade = v))} />
        <span className="label">s</span>

        {/* The look pool is shared by every song, so the header says how far an
            edit here reaches before it is made — and offers the way out. */}
        <button
          ref={sharedBtn}
          className={`chip sharedby ${count.pads > 1 ? 'many' : ''}`}
          title={`this look sits on ${count.pads} pad${count.pads === 1 ? '' : 's'} across ${count.songs} song${count.songs === 1 ? '' : 's'} — every edit here reaches all of them. Click for a copy of its own`}
          onClick={() => openAt(sharedBtn, setShared)}
        >
          on {count.pads} pad{count.pads === 1 ? '' : 's'} · {count.songs} song{count.songs === 1 ? '' : 's'} ▾
        </button>

        <button
          className={`btn small ${playing ? 'on' : ''}`}
          title="fire this look on its layer now, exactly as clicking the pad would"
          onClick={() => send({ type: 'trigger', layerId: layer.id, col: sel.col })}
        >
          ▶ fire
        </button>
        <button
          className={`btn small warn ${ride ? 'on' : ''}`}
          title="NUDGE: fader moves become live nudges — they drive the rig without touching the show (no project write, no undo spam). Keep writes them into the look, Discard drops them. Cleared by ALL STOP and project switch."
          onClick={() => setRide(!ride)}
        >
          nudge
        </button>

        <div className="grow" />
        <button
          ref={moreBtn}
          className="btn small ghost"
          title="more for this look — swap the pad's look, empty the pad, or delete the look everywhere"
          aria-label="more"
          onClick={() => openAt(moreBtn, setMore)}
        >
          ⋯
        </button>
      </div>

      {/* The look ridden whole (A41): four dials that offset every part at
          once, down the same soft path a fader nudge takes — so the held chip
          counts them, Keep writes them in and Discard drops them. A steps look
          has no parts of its own to offset; its steps are ridden in their own
          pads. */}
      {!look.steps?.length && <OffsetDials lookId={lookId} look={look} />}

      {shared && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={closeMenus} />
          <div className="popover" style={{ top: shared.top, left: shared.left }}>
            <div className="menuhead">shared by {count.pads} pad{count.pads === 1 ? '' : 's'}</div>
            <span className="prose">
              One look, one entry in the pool. Renaming it, or moving a fader in it, changes it on every
              pad in every song at once.
            </span>
            <div className="popover-rule" />
            <button
              className="btn small ghost"
              disabled={count.pads < 2}
              title={count.pads < 2
                ? 'nothing else uses it — this pad already has it to itself'
                : 'put a copy on this pad only, so edits here stop reaching the other pads'}
              onClick={() => {
                closeMenus();
                mutate((p) => {
                  const src = p.looks[lookId];
                  if (!src) return;
                  const copy = copyOfLook(src);
                  p.looks[copy.id] = copy;
                  const ly = p.layers.find((l) => l.id === sel.layerId);
                  if (ly) ly.cells[sel.col] = copy.id;
                }, 'make this pad its own copy');
              }}
            >
              make this pad its own copy
            </button>
          </div>
        </>
      )}

      {more && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={closeMenus} />
          <div className="popover" style={{ top: more.top, left: more.left }}>
            <div className="menuhead">put another look on this pad</div>
            <select
              className="sel"
              value={lookId}
              title="swap this pad's look for another from the pool"
              onChange={(e) => {
                const id = e.target.value;
                closeMenus();
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
            <div className="popover-rule" />
            <button
              className="btn small ghost"
              title="empty this pad. The look stays in the library and on any other pad using it."
              onClick={() => {
                closeMenus();
                mutate((p) => {
                  const ly = p.layers.find((l) => l.id === sel.layerId);
                  if (ly) ly.cells[sel.col] = null;
                });
              }}
            >
              clear pad
            </button>
            <button
              className="btn small ghost"
              title="delete the look from the library and from every pad in every song that uses it"
              onClick={() => {
                closeMenus();
                void (async () => {
                  const refs = Object.values(project.looks).filter(
                    (l) => l.steps?.some((st) => st.lookId === lookId),
                  );
                  // the look lives in ONE pool shared by every song — deleting it
                  // blanks its pad in each of them, which was silent before
                  const decksHit = (project.decks ?? []).filter((d) =>
                    Object.values(d.cells).some((cells) => cells.includes(lookId)),
                  );
                  const cellCount = (project.decks ?? []).reduce(
                    (n, d) =>
                      n + Object.values(d.cells).reduce((m, cells) => m + cells.filter((c) => c === lookId).length, 0),
                    0,
                  );
                  // The CURRENT song's pads live in project.layers, not in the
                  // stored page — that only syncs on a song switch. A look
                  // placed in this song since the last switch was invisible to the
                  // scan above, so deleting it emptied pads with no warning at all.
                  const liveCells = project.layers.reduce(
                    (n, ly) => n + ly.cells.filter((c) => c === lookId).length,
                    0,
                  );
                  if (refs.length > 0 || decksHit.length > 0 || liveCells > 0) {
                    const parts: string[] = [];
                    if (liveCells > 0) {
                      parts.push(
                        `It is on ${liveCells} pad(s) of the song you are on. Those pads will be emptied.`,
                      );
                    }
                    if (decksHit.length > 0) {
                      parts.push(
                        `It is on ${cellCount} pad(s) across ${decksHit.length} song(s): ${decksHit
                          .map((d) => d.name)
                          .join(', ')}. Those pads will be emptied.`,
                      );
                    }
                    if (refs.length > 0) {
                      parts.push(
                        `It is a step in ${refs.length} look(s): ${refs.map((l) => l.name).join(', ')}. Those steps will go dark.`,
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
                    // stored songs hold their own copies of the pads
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
        </>
      )}

      {look.steps?.length ? (
        <div>
          <div className="sectionhead" style={{ marginTop: 10 }}>
            Steps — hard cuts on the beat, loops, starts at step 1 when fired
          </div>
          {look.steps.map((st, i) => (
            <div className="row" key={i} style={{ marginBottom: 4 }}>
              <span className="chip">{i + 1}</span>
              <select
                className="sel"
                title="the look this step fires"
                value={st.lookId}
                onChange={(e) => editLook((lk) => { if (lk.steps?.[i]) lk.steps[i].lookId = e.target.value; })}
              >
                {(() => {
                  // hasOwn: a prototype-key step id must read as "missing", not
                  // resolve to Object.prototype and mislabel itself
                  const stepLook = Object.hasOwn(project.looks, st.lookId) ? project.looks[st.lookId] : undefined;
                  return !stepLook || stepLook.steps?.length ? (
                    <option value={st.lookId}>
                      {stepLook ? '(has steps — renders dark)' : '(missing look)'}
                    </option>
                  ) : null;
                })()}
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
                title="move this step earlier"
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
                title="move this step later"
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
                title="remove this step"
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
            <PartEditor key={part.id} lookId={lookId} part={part} ride={ride} />
          ))}

          <div className="row">
            <button
              className="btn small ghost"
              onClick={() => editLook((lk) => lk.parts.push({ id: uid('part'), groupId: project.groups[0]?.id ?? '', params: { dimmer: 1 }, effects: [] }))}

            title="add another fixture group to this look, with its own colour, position and effects">
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
                      ? `used as a step by ${referencedBy} look(s) — steps cannot nest`
                      : eligible
                        ? 'give this look steps — it then plays other looks in turn, on the beat'
                        : 'needs at least one other plain look to step through'
                  }
                  onClick={() => editLook((lk) => {
                    const first = Object.values(project.looks).find((l) => !l.steps?.length && l.id !== lookId);
                    if (first) lk.steps = [{ lookId: first.id, beats: 1 }];
                  })}
                >
                  ⛓ steps
                </button>
              );
            })()}
          </div>

          {(project.fxPool?.length ?? 0) > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="sectionhead">FX pool — reusable presets ({project.fxPool!.length})</div>
              <div className="label" style={{ marginBottom: 6 }}>
                Copies in on “apply from pool”, so editing a look never rewrites the preset — and editing the preset never changes a look already using it.
              </div>
              {project.fxPool!.map((fp) => (
                <div className="row" key={fp.id} style={{ marginBottom: 4 }}>
                  <TextField
                    className="text"
                    style={{ width: 180, fontSize: 13 }}
                    entityId={fp.id}
                    value={fp.name}
                    onCommit={(v) => mutate((p) => {
                      const e = p.fxPool?.find((x) => x.id === fp.id);
                      if (e) e.name = v;
                    })}
                  />
                  <span className="label">{fp.effect.target} · {fp.effect.wave}</span>
                  <div className="grow" />
                  <button
                    className="btn small ghost"
                    title="remove this preset from the pool (looks that already used it keep their copy)"
                    onClick={() => mutate((p) => {
                      p.fxPool = (p.fxPool ?? []).filter((x) => x.id !== fp.id);
                      if (p.fxPool.length === 0) delete p.fxPool;
                    })}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
