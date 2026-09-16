// Pinning groups: the GROUPS head's menu (design A14, decision 2).
//
// Pinned groups come first on the GROUPS row, in the order they were pinned,
// and the APC40 mk2 · busk layout gives the first four of that row track
// faders 5–8. The list keeps the show's own order while you pin, so the key
// under the pointer never jumps away from it; the number on a pinned key is its
// place on the row. A pin is a show edit and undoes like one, so a locked
// client is never offered the menu at all.
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { livePins, togglePin } from '../groupOrder.ts';
import { Glyph } from '../glyphs.tsx';

export function GroupPins({ label }: { label: string }): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const pins = livePins(project);

  return (
    <>
      <button
        ref={btn}
        className="name grow namekey"
        title="pin groups — pinned groups come first on this row, and the APC40 mk2 · busk layout puts the first four on track faders 5–8"
        aria-expanded={open}
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          // opens upward: the row sits at the foot of the grid
          if (r) setPos({ top: r.top, left: r.left });
          setOpen((o) => !o);
        }}
      >
        {label} <Glyph name="chevron" />
      </button>
      {open && (
        <div
          ref={box}
          className="popover grouppins"
          style={{ top: pos.top, left: pos.left }}
          role="menu"
          aria-label="pin groups"
        >
          <div className="modaltitle">pin groups</div>
          <div className="prose">
            Pinned groups come first on this row. The APC40 mk2 · busk layout puts the first four on track faders 5–8 when you load it.
          </div>
          <div className="pinlist">
            {project.groups.map((g) => {
              const slot = pins.indexOf(g.id);
              const pinned = slot >= 0;
              return (
                <button
                  key={g.id}
                  role="menuitemcheckbox"
                  aria-checked={pinned}
                  className={`btn small ${pinned ? 'on' : 'ghost'}`}
                  title={
                    pinned
                      ? `${g.name} is ${slot + 1} on the row${slot < 4 ? ` — track fader ${slot + 5} in the busk layout` : ''}. Click to unpin it`
                      : `pin ${g.name} after the ones already pinned`
                  }
                  onClick={() => mutate((p) => togglePin(p, g.id), `${pinned ? 'unpin' : 'pin'} group “${g.name}”`)}
                >
                  {pinned && <span className="pinslot">{slot + 1}</span>}
                  {g.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
