import React, { useEffect, useMemo, useRef, useState } from 'react';
import { notify, useStore } from '../store.ts';
import { askConfirm, askPrompt } from '../dialog.tsx';
import { uid } from '../../../shared/types.ts';
import { size } from '../tokens.ts';
import { closeLibrarySheet, useEditingDeckId, useLibraryStore } from '../libraryStore.ts';
import { BANK, FILTERS, FILTER_HELP, FILTER_LABEL, entries, filtered, type LibraryEntry, type LibraryFilter } from './library/model.ts';
import { LookTile } from './library/LookTile.tsx';
import { Menu, type MenuAt, type MenuItem } from './library/Menu.tsx';
import { Glyph } from '../glyphs.tsx';
import { firstPad, selectPad, showOnPlan } from './library/reveal.ts';
import '../styles/library.css';

/** The look pool, as tiles (design 2.7, #29).
 *
 *  Looks live in one project-wide pool; a pad only points at one, and the same
 *  look sits on pads in many songs. This is the only surface that shows the
 *  pool itself, so it has to answer the questions the grid cannot: which of
 *  these two Ashes is the one on the derbies (the face, and the group beside a
 *  twin's name), what does this one do (the kinds and the corner marks), and
 *  is anything still using it (`×pads · songs`, counted across every song —
 *  the old `×N` counted the current song only, which is the one number that
 *  cannot answer it).
 *
 *  Every chip is computed from the show. Nothing here is a tag somebody has to
 *  remember to keep true.
 */
export function LookLibrary() {
  const setLibraryHidden = useStore((s) => s.setLibraryHidden);
  return (
    <LibraryBody
      close={{ label: '▸', title: 'hide the look library — the pad grid takes the full width', run: () => setLibraryHidden(true) }}
    />
  );
}

/** The same library, laid over the grid from the right: narrow windows, and
 *  touch, where a column beside eight pads does not fit at all. Opened and
 *  closed by `openLibrarySheet()` / `closeLibrarySheet()`. */
export function LibrarySheet() {
  const open = useLibraryStore((s) => s.sheet);
  if (!open) return null;
  return (
    <>
      {/* No veil: the pads behind this are playing, and a sheet that hides
          them is a sheet you cannot use mid-song. It is a panel that happens
          to be on top. */}
      <div className="librarysheet panel">
        <LibraryBody close={{ label: '✕', title: 'close the look library', run: closeLibrarySheet }} />
      </div>
    </>
  );
}

/** The library as a popover: the same list, chips and search, handing back one
 *  look id. This is what replaces the editor's two 190-entry `<select>`s —
 *  a flat alphabetical menu of 190 names that could not say which Ash was
 *  which, and could not be searched. Anchor it to the control that opened it.
 */
export function LookPicker({
  anchor,
  current,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  /** the look the control holds now, marked in the list */
  current?: string | null;
  onPick: (lookId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const r = anchor?.getBoundingClientRect();
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && e.target !== anchor) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);
  return (
    <div
      ref={ref}
      className="popover lookpicker"
      style={{ top: (r?.bottom ?? 0) + 2, left: Math.max(0, Math.min(r?.left ?? 0, window.innerWidth - size['picker-w'])) }}
    >
      <LibraryBody pick={{ current: current ?? null, onPick: (id) => { onPick(id); onClose(); } }} />
    </div>
  );
}

type Close = { label: string; title: string; run: () => void };

function LibraryBody({ close, pick }: { close?: Close; pick?: { current: string | null; onPick: (id: string) => void } }) {
  const project = useStore((s) => s.project)!;
  const touch = useStore((s) => s.touch);
  const mutate = useStore((s) => s.mutate);
  const sel = useStore((s) => s.sel);
  const editingDeckId = useEditingDeckId();
  // What is playing, as a string: the snapshot arrives many times a second and
  // a new array every time, so subscribing to it would re-render 190 looks per
  // frame. This changes only when a layer changes look.
  const liveKey = useStore((s) => (s.snap?.layers ?? []).map((l) => l.lookId ?? '').join('|'));
  const armed = useLibraryStore((s) => s.armed);
  const arm = useLibraryStore((s) => s.arm);
  const disarm = useLibraryStore((s) => s.disarm);
  const reveal = useLibraryStore((s) => s.reveal);
  const q = useLibraryStore((s) => s.q);
  const setQ = useLibraryStore((s) => s.setQ);

  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [groupId, setGroupId] = useState('');
  const [page, setPage] = useState(0);
  const [menu, setMenu] = useState<{ at: MenuAt; entry: LibraryEntry } | null>(null);

  const all = useMemo(() => {
    const onStage = new Set(liveKey.split('|').filter(Boolean));
    return entries(project, editingDeckId, onStage);
  }, [project, editingDeckId, liveKey]);

  // Two looks of one name is the case the group beside the name exists for —
  // the shipped show has eight such pairs — so it is printed only there.
  const twins = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of all) n.set(e.look.name, (n.get(e.look.name) ?? 0) + 1);
    return n;
  }, [all]);

  const hits = useMemo(() => filtered(all, filter, groupId, q), [all, filter, groupId, q]);
  const counts = useMemo(() => {
    const m = new Map<LibraryFilter, number>();
    for (const f of FILTERS) m.set(f, filtered(all, f, groupId, q).length);
    return m;
  }, [all, groupId, q]);

  // A filter or a search that empties the bank you were on puts you on the
  // last one that has tiles, never on an empty page of nothing.
  const banks = Math.max(1, Math.ceil(hits.length / BANK));
  const at = Math.min(page, banks - 1);
  useEffect(() => {
    if (page !== at) setPage(at);
  }, [page, at]);

  // Find (and the tile menu's "show in library") ask for one look: take the
  // bank that holds it, without disturbing the filter that found it.
  useEffect(() => {
    if (!reveal) return;
    const i = hits.findIndex((e) => e.look.id === reveal);
    if (i >= 0) setPage(Math.floor(i / BANK));
  }, [reveal, hits]);

  // Esc drops the arm before anything else reads it: the arm is the innermost
  // thing on screen, so it is the first thing Esc should give back.
  useEffect(() => {
    if (!armed) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      disarm();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [armed, disarm]);

  const shown = hits.slice(at * BANK, at * BANK + BANK);
  const armedLook = armed ? project.looks[armed] : undefined;
  const deckId = project.activeDeckId ?? '';

  const newLook = () => {
    const id = uid('look');
    mutate((p) => {
      p.looks[id] = {
        id,
        name: 'New look',
        parts: [{ id: uid('part'), groupId: p.groups[0]?.id ?? '', params: { dimmer: 1 }, effects: [] }],
      };
    }, 'add a look');
    arm(id);
  };

  const menuItems = (e: LibraryEntry): MenuItem[] => {
    const pad = firstPad(e.look.id);
    const heads = project.groups
      .filter((g) => e.look.parts.some((p) => p.groupId === g.id))
      .flatMap((g) => g.heads.map((h) => h.fixtureId));
    return [
      {
        label: 'open',
        title: pad
          ? 'select the pad this look is on — the editor follows the selection, and nothing fires'
          : 'this look is on no pad in this song — arm it and tap a pad’s name first',
        disabled: !pad,
        run: () => pad && selectPad(pad.layerId, pad.col),
      },
      {
        label: 'rename',
        title: 'rename the look everywhere it is used',
        run: () => {
          void askPrompt(`Rename “${e.look.name}”`, e.look.name, {
            body: 'One look, one name: every pad in every song that points at it reads the new one.',
            confirmLabel: 'Rename',
          }).then((name) => {
            const trimmed = name?.trim();
            if (!trimmed) return;
            mutate((p) => {
              const lk = p.looks[e.look.id];
              if (lk) lk.name = trimmed;
            }, 'rename a look');
          });
        },
      },
      {
        label: 'put on this pad in every song',
        title: sel
          ? 'write this look onto the selected pad of every song in the show — undo takes it back out'
          : 'select a pad first — this puts the look on the same pad of every song',
        disabled: !sel,
        run: () => sel && putEverywhere(e.look.id, sel.layerId, sel.col),
      },
      {
        label: 'show on pads',
        title: pad ? 'select its pad and scroll the grid to it — nothing fires' : 'it is on no pad in this song',
        disabled: !pad,
        run: () => pad && selectPad(pad.layerId, pad.col),
      },
      {
        label: 'show on plan',
        title: heads.length ? 'select the heads this look drives, on the plan' : 'its groups are not in this rig',
        disabled: heads.length === 0,
        run: () => showOnPlan(heads),
      },
      {
        label: `delete — used on ${e.pads} pad${e.pads === 1 ? '' : 's'} in ${e.songs} song${e.songs === 1 ? '' : 's'}`,
        title: 'delete the look from the library and empty every pad in every song that uses it',
        danger: true,
        run: () => deleteLook(e),
      },
    ];
  };

  const putEverywhere = (lookId: string, layerId: string, col: number) => {
    mutate((p) => {
      const l = p.layers.find((x) => x.id === layerId);
      if (l) {
        while (l.cells.length < col) l.cells.push(null);
        l.cells[col] = lookId;
      }
      for (const d of p.decks ?? []) {
        const cells = d.cells[layerId] ?? [];
        while (cells.length < col) cells.push(null);
        cells[col] = lookId;
        d.cells[layerId] = cells;
      }
    }, 'put a look on every song');
    const songs = (project.decks ?? []).length || 1;
    notify(`${project.looks[lookId]?.name ?? 'that look'} is on that pad in all ${songs} songs — undo takes it back out`);
  };

  const deleteLook = (e: LibraryEntry) => {
    const id = e.look.id;
    const steps = Object.values(project.looks).filter((l) => l.steps?.some((st) => st.lookId === id));
    void (async () => {
      if (e.pads > 0 || steps.length > 0) {
        const body = [
          e.pads > 0 ? `Used on ${e.pads} pad${e.pads === 1 ? '' : 's'} in ${e.songs} song${e.songs === 1 ? '' : 's'}. Those pads will be emptied.` : '',
          steps.length > 0 ? `It is a step in ${steps.length} look${steps.length === 1 ? '' : 's'}: ${steps.map((l) => l.name).join(', ')}. Those steps will go dark.` : '',
        ].filter(Boolean).join('\n\n');
        const ok = await askConfirm(`Delete “${e.look.name}”?`, { body, confirmLabel: 'Delete', danger: true });
        if (!ok) return;
      }
      mutate((p) => {
        delete p.looks[id];
        for (const ly of p.layers) ly.cells = ly.cells.map((c) => (c === id ? null : c));
        for (const d of p.decks ?? []) {
          for (const [lid, cells] of Object.entries(d.cells)) d.cells[lid] = cells.map((c) => (c === id ? null : c));
        }
      }, 'delete a look');
      if (armed === id) disarm();
    })();
  };

  const group = project.groups.find((g) => g.id === groupId);

  return (
    <>
      <div className="previzbar libbar">
        {close && (
          <button className="btn small ghost pin" title={close.title} onClick={close.run}>
            {close.label}
          </button>
        )}
        <span className="label">looks</span>
        <span className="label dim">{group ? `${group.name} ${hits.length}` : hits.length}</span>
        <div className="grow" />
        <input
          className="text libsearch"
          placeholder="search…"
          value={q}
          // This box lives in the PERFORMANCE view, and the global key handler
          // steps aside for any focused input — so a search box left focused
          // eats 1-9, t, b and [ ]. Escape and Enter give the keyboard back to
          // the show; so does starting a drag.
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setQ('');
              e.currentTarget.blur();
            } else if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="libchips">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`chip libchip ${filter === f ? 'on' : ''}`}
            disabled={f !== 'all' && counts.get(f) === 0}
            title={FILTER_HELP[f]}
            onClick={() => {
              setFilter(f);
              setPage(0);
            }}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
        <select
          className="chip chipsel libchip"
          value={groupId}
          title="only looks that touch one group of the rig"
          onChange={(e) => {
            setGroupId(e.target.value);
            setPage(0);
          }}
        >
          <option value="">group</option>
          {project.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>

      <div className="libtiles">
        {shown.map((e) => (
          <LookTile
            key={e.look.id}
            entry={e}
            twin={(twins.get(e.look.name) ?? 0) > 1}
            armed={armed === e.look.id}
            revealed={reveal === e.look.id}
            deckId={deckId}
            touch={touch}
            onArm={() => (pick ? pick.onPick(e.look.id) : armed === e.look.id ? disarm() : arm(e.look.id))}
            onMenu={(at) => setMenu({ at, entry: e })}
          />
        ))}
        {hits.length === 0 && (
          <div className="libempty chip">
            {q.trim() ? (
              <>
                <Glyph name="find" />
                <span>nothing called “{q.trim()}”</span>
                <button className="btn small ghost" onClick={() => setQ('')}>clear search</button>
              </>
            ) : all.length === 0 ? (
              <>
                <Glyph name="add" />
                <span>no looks yet</span>
                <button className="btn small ghost" onClick={newLook}>+ new look</button>
              </>
            ) : (
              <>
                <Glyph name="find" />
                <span>no {FILTER_LABEL[filter]} looks</span>
                <button className="btn small ghost" onClick={() => setFilter('all')}>show all</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Bank arrows, not a paginator: sixteen is two rows of the APC's 5×8,
          so a bank here is a bank there. */}
      {hits.length > BANK && (
        <div className="libbank">
          <button
            className="btn small ghost"
            disabled={at === 0}
            title="the bank before this one"
            onClick={() => setPage(at - 1)}
          >
            ‹
          </button>
          <span className="val">
            {at * BANK + 1}–{Math.min(hits.length, at * BANK + BANK)}
          </span>
          <button
            className="btn small ghost"
            disabled={at >= banks - 1}
            title="the next bank"
            onClick={() => setPage(at + 1)}
          >
            ›
          </button>
          <span className="label dim">of {hits.length}</span>
        </div>
      )}

      {!pick && (
        armedLook ? (
          <div className="libhint libarm">
            <span className="armed" />
            <span className="grow">
              place {armedLook.name} · {touch ? 'tap' : 'click'} a pad’s name
            </span>
            <button className="btn small ghost" title="stop placing — Esc does this too" onClick={disarm}>
              done
            </button>
          </div>
        ) : (
          <div className="libhint">
            {touch ? 'tap' : 'click'} a look to arm it, then {touch ? 'tap' : 'click'} a pad’s name — pads point at the
            look, so one edit updates every pad using it
          </div>
        )
      )}

      {menu && <Menu at={menu.at} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
    </>
  );
}
