// Project-wide find (design 2.7, #39).
//
// "Which song has Ember Blue on the drop" has no answer in the app today: the
// library searches look names and nothing else searches anything. This is one
// field over the whole show — looks, songs, columns, groups and fixtures — and
// the thing that makes it usable during a song is that Enter does the SMALLEST
// thing that answers the question, per kind:
//
//   look     select its first pad here, or open the library on it
//   song     switch the stage — the one live action, and it says so
//   column   scroll to it, and never, ever fire it
//   group    its row in the Rig
//   fixture  select it on the plan
//
// A column head is one of the five gestures that reach the rig. Find is not a
// sixth: it moves the eye and the cursor, and only a song row moves a light.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store.ts';
import { openLibrarySheet } from '../libraryStore.ts';
import { usage } from './library/model.ts';
import { firstPad, selectPad, showColumn, showGroup } from './library/reveal.ts';
import { Find as FindMark } from './library/marks.tsx';
import '../styles/library.css';

type FindStore = { open: boolean; set: (v: boolean) => void };
const useFind = create<FindStore>()((set) => ({ open: false, set: (v) => set({ open: v }) }));

/** Open find. The ⌘F and `/` bindings live with the rest of the keyboard. */
export const openFind = (): void => useFind.getState().set(true);
export const closeFind = (): void => useFind.getState().set(false);

type Hit =
  | { kind: 'look'; key: string; name: string; detail: string; act: () => void }
  | { kind: 'song'; key: string; name: string; detail: string; live: boolean; act: () => void }
  | { kind: 'column'; key: string; name: string; detail: string; act: () => void }
  | { kind: 'group'; key: string; name: string; detail: string; act: () => void }
  | { kind: 'fixture'; key: string; name: string; detail: string; act: () => void };

/** The word printed beside each hit — what kind of thing it is, in the app's
 *  own nouns. */
const KIND_WORD: Record<Hit['kind'], string> = {
  look: 'look',
  song: 'song',
  column: 'column',
  group: 'group',
  fixture: 'light',
};

/** How many of each kind before the list stops being a list. */
const PER_KIND = 6;

export function Find() {
  const open = useFind((s) => s.open);
  const project = useStore((s) => s.project);
  const send = useStore((s) => s.send);
  const setFxSel = useStore((s) => s.setFxSel);
  const setView = useStore((s) => s.setView);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setAt(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!project || !needle) return [];
    const match = (s: string) => s.toLowerCase().includes(needle);
    // A name that STARTS with what was typed is what was meant; everything
    // else that contains it follows.
    const rank = (s: string) => (s.toLowerCase().startsWith(needle) ? 0 : 1);
    const take = <T,>(xs: T[], name: (x: T) => string) =>
      xs.filter((x) => match(name(x)))
        .sort((a, b) => rank(name(a)) - rank(name(b)) || name(a).localeCompare(name(b)))
        .slice(0, PER_KIND);

    const used = usage(project);
    const out: Hit[] = [];

    for (const look of take(Object.values(project.looks), (l) => l.name)) {
      const u = used.get(look.id);
      const pads = u?.pads ?? 0;
      out.push({
        kind: 'look',
        key: look.id,
        name: look.name,
        detail: pads
          ? `on ${pads} pad${pads === 1 ? '' : 's'} in ${u?.songs ?? 0} song${(u?.songs ?? 0) === 1 ? '' : 's'}`
          : 'on no pad',
        act: () => {
          const pad = firstPad(look.id);
          if (pad) selectPad(pad.layerId, pad.col);
          else openLibrarySheet(look.id);
        },
      });
    }

    const decks = project.decks ?? [];
    for (const deck of take(decks, (d) => d.name)) {
      const live = deck.id === project.activeDeckId;
      out.push({
        kind: 'song',
        key: deck.id,
        name: deck.name,
        live,
        detail: live ? 'on stage now' : 'goes live',
        act: () => {
          if (!live) send({ type: 'switchDeck', deckId: deck.id });
        },
      });
    }

    const cols = project.columns.map((name, col) => ({ name, col }));
    for (const c of take(cols, (x) => x.name)) {
      out.push({
        kind: 'column',
        key: `col-${c.col}`,
        name: c.name,
        detail: `column ${c.col + 1} — scrolls to it, never fires it`,
        act: () => showColumn(c.col),
      });
    }

    for (const g of take(project.groups, (x) => x.name)) {
      out.push({
        kind: 'group',
        key: g.id,
        name: g.name,
        detail: `${g.heads.length} head${g.heads.length === 1 ? '' : 's'} — opens the Rig`,
        act: () => showGroup(g.id),
      });
    }

    for (const f of take(project.fixtures, (x) => x.name)) {
      out.push({
        kind: 'fixture',
        key: f.id,
        name: f.name,
        detail: `address ${f.address} — opens the Rig`,
        act: () => {
          setView('patch');
          setFxSel([f.id]);
        },
      });
    }
    return out;
  }, [project, q, send, setFxSel, setView]);

  const cur = Math.min(at, Math.max(0, hits.length - 1));
  useEffect(() => {
    listRef.current?.querySelector('.findrow.selected')?.scrollIntoView({ block: 'nearest' });
  }, [cur, hits.length]);

  if (!open || !project) return null;

  const run = (hit: Hit | undefined) => {
    if (!hit) return;
    closeFind();
    hit.act();
  };

  return (
    <div
      className="findbox popover"
      role="dialog"
      aria-label="find anything in this show"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="findbar">
        <FindMark />
        <input
          ref={inputRef}
          className="text findfield"
          placeholder="find a look, song, column, group or light…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onBlur={closeFind}
          onKeyDown={(e) => {
            // This field swallows the show's keys while it has focus, which is
            // exactly why Esc has to give them back on the first press.
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              closeFind();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((i) => Math.min(hits.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(hits[cur]);
            }
          }}
        />
        <button className="btn small ghost" title="close find — Esc does this too" onMouseDown={(e) => e.preventDefault()} onClick={closeFind}>
          ✕
        </button>
      </div>
      <div className="findlist" ref={listRef} role="listbox">
        {hits.map((h, i) => (
          <div
            key={h.key}
            className={`findrow ${i === cur ? 'selected' : ''} ${h.kind === 'song' && !h.live ? 'goeslive' : ''}`}
            role="option"
            aria-selected={i === cur}
            title={`${h.name} — ${h.detail}`}
            onMouseDown={(e) => e.preventDefault()}
            onPointerEnter={() => setAt(i)}
            onClick={() => run(h)}
          >
            <span className="kind">{KIND_WORD[h.kind]}</span>
            <span className="name">{h.name}</span>
            <span className="detail">{h.detail}</span>
          </div>
        ))}
        {q.trim() && hits.length === 0 && (
          <div className="findrow empty">nothing called “{q.trim()}”</div>
        )}
        {!q.trim() && (
          <div className="findrow empty">
            looks, songs, columns, groups and lights — Enter opens one; only a song changes the stage
          </div>
        )}
      </div>
    </div>
  );
}
