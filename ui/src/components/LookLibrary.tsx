import React, { useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { lookSwatch } from '../lookColors.ts';

/** The look pool, as a drag source for the pad grid (pads view, bottom right).
 *
 *  Looks live in the project-wide pool; a pad only points at one. Before this
 *  panel, a look that was not on a pad of the current song was unreachable —
 *  building the next song meant re-creating looks that already existed. Drag a
 *  row onto any pad and the pad points at that look.
 */
export function LookLibrary() {
  const project = useStore((s) => s.project)!;
  const setLibraryHidden = useStore((s) => s.setLibraryHidden);
  const [q, setQ] = useState('');

  const looks = useMemo(() => {
    const all = Object.values(project.looks);
    const needle = q.trim().toLowerCase();
    const hits = needle ? all.filter((l) => l.name.toLowerCase().includes(needle)) : all;
    return hits.sort((a, b) => a.name.localeCompare(b.name));
  }, [project.looks, q]);

  // Pads of the CURRENT song already pointing at each look — the number that
  // answers "is dragging this in a duplicate?" at a glance.
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of project.layers) for (const id of l.cells) if (id) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [project.layers]);

  return (
    <>
      <div className="previzbar">
        <button
          className="btn small ghost pin"
          title="hide the look library — the pad grid takes the full width"
          onClick={() => setLibraryHidden(true)}
        >
          ▸
        </button>
        <span className="label">look library</span>
        <span className="label dim">{looks.length}</span>
        <div className="grow" />
        <input
          className="text"
          style={{ width: 96 }}
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
      <div className="librarylist">
        {looks.length === 0 && (
          <div className="label" style={{ padding: '14px 6px', whiteSpace: 'normal', lineHeight: 1.6 }}>
            {q ? 'no looks match' : 'no looks yet — click an empty pad to start one'}
          </div>
        )}
        {looks.map((look) => {
          const n = used.get(look.id) ?? 0;
          return (
            <div
              key={look.id}
              className="librow"
              draggable
              title={`${look.name} — drag onto a pad. Pads share the look: an edit anywhere follows to every pad using it.`}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-light-look', look.id);
                // the song this drag belongs to — a deck switch landing mid-drag
                // (APC bank arrow, another client) must not redirect the drop
                e.dataTransfer.setData('application/x-light-deck', project.activeDeckId ?? '');
                e.dataTransfer.effectAllowed = 'copy';
                // hand the keyboard back to the show before the drop lands
                (document.activeElement as HTMLElement | null)?.blur();
              }}
            >
              <span className="swatch mini">
                {lookSwatch(look, project.looks).map((c, i) => (
                  <i key={i} style={{ background: c }} />
                ))}
              </span>
              <span className="name">{look.steps?.length ? '⛓ ' : ''}{look.name}</span>
              {look.flash && (
                <span className="chip" title="momentary — this look holds only while the pad is held">FLASH</span>
              )}
              {n > 0 && (
                <span className="chip" title={`already on ${n} pad${n > 1 ? 's' : ''} in this song`}>
                  ×{n}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="libhint">
        drag a look onto a pad — pads point at the look, so one edit updates every pad using it
      </div>
    </>
  );
}
