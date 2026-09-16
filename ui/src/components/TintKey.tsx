// Tint what is playing (design A12, slice 2 — Titan's quick palettes).
//
// Retuning a colour is a build-time act. Tinting what is on stage right now —
// the song went cold and the room wants it warmer — is a performing one, and it
// should not mean opening the editor on a look mid-song. A tap on a palette here
// nudges every coloured part of every look a layer is playing to that colour.
//
// It is a NUDGE, with everything a nudge already is: the held chip counts it,
// Keep writes it into the looks, Discard sends each part back over its own fade,
// ALL STOP ends it, and blind keeps it off the rig. Nothing new reaches the rig,
// no new engine state, no new command — the soft door every nudge already uses.
import React, { useEffect, useRef, useState } from 'react';
import { hsvToRgb, rgbHex } from '../../../shared/color.ts';
import { useStore } from '../store.ts';
import { palettesOf, playingColourParts } from '../palettes.ts';
import { Glyph } from '../glyphs.tsx';

export function TintKey(): React.ReactElement | null {
  const project = useStore((s) => s.project);
  const send = useStore((s) => s.send);
  // which looks are playing, as one string: the key re-renders when that
  // changes, not on every snapshot the engine sends
  const playing = useStore((s) => (s.snap?.layers ?? []).map((l) => l.lookId ?? '').join('\t'));
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

  if (!project) return null;
  const reach = playingColourParts(project, playing.split('\t'));
  const pals = palettesOf(project);

  const tint = (h: number, s: number): void => {
    for (const { lookId, partId } of reach) {
      send({ type: 'soft', lookId, partId, field: 'hue', value: h });
      send({ type: 'soft', lookId, partId, field: 'sat', value: s });
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btn}
        className="btn small ghost"
        // greyed rather than hidden: the key is always where the hand expects
        // it, and its help says why it has nothing to tint
        disabled={reach.length === 0}
        title={
          reach.length === 0
            ? 'tint what is playing — nothing on stage has a colour of its own to tint'
            : `tint what is playing — nudges the colour of ${reach.length} part${reach.length === 1 ? '' : 's'} on stage. Keep writes it into the looks; Discard sends it back`
        }
        aria-expanded={open}
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 320)) });
          setOpen((o) => !o);
        }}
      >
        tint <Glyph name="chevron" />
      </button>
      {open && (
        <div ref={box} className="popover tintstrip" style={{ top: pos.top, left: pos.left }} role="menu" aria-label="tint what is playing">
          <div className="modaltitle">tint what is playing</div>
          <div className="swatches">
            {pals.map((p) => {
              const [r, g, b] = hsvToRgb(p.h, p.s, 1);
              return (
                <i
                  key={p.id}
                  role="menuitem"
                  tabIndex={0}
                  aria-label={p.name}
                  title={`${p.name} — nudge everything playing to it`}
                  style={{ background: rgbHex(r, g, b) }}
                  onClick={() => tint(p.h, p.s)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tint(p.h, p.s); } }}
                />
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
