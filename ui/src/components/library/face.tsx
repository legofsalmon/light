// The rig miniature, drawn (design 2.3, #30).
//
// `lookFace` decides WHAT the marks are; this decides nothing — it lays them
// out left to right in the order they came in, which is stage order. Kept in
// one component because the pad, the library tile and the picker must draw the
// same face: three drawings of one look is three looks, at a glance, in a dark
// room.
//
// It never feeds `--pad-glow` or the layer head's mini swatch. Those stay on
// `lookSwatch[0]`, which is what the APC's LEDs read — the screen and the
// hardware agree by reading one rule, not by two rules looking similar.

import React from 'react';
import type { LookFace } from '../../lookColors.ts';
import '../../styles/library.css';

/** How many dots a steps look shows before it just says "a lot". */
const DOTS = 8;

export function Face({ face, className = '' }: { face: LookFace; className?: string }) {
  if (!face.marks.length && !face.steps) return <div className={`face empty ${className}`} />;
  return (
    <div className={`face ${className}`}>
      {face.marks.map((m, i) => (
        <i
          key={`${m.groupId}-${i}`}
          className={m.hollow ? 'hollow' : ''}
          style={{ ['--mark' as string]: m.color }}
        />
      ))}
      {face.steps > 0 && (
        <div className="dots">
          {Array.from({ length: Math.min(face.steps, DOTS) }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
    </div>
  );
}
