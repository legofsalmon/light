// The colour picker (backlog #15).
//
// Hue and saturation were two faders. Two faders are fine for nudging one of
// them and useless for the thing an operator actually does, which is "a bit
// more amber than that" — a move in two dimensions at once, made by eye.
//
// So: a disc. Angle is hue, distance from the middle is saturation, and the
// centre is white. Everything it emits is the same `ColorHS` the faders emit
// and it goes out through the same callback, so a colour being nudged stays
// nudged and the stored show is not quietly rewritten underneath a ride.
//
// The disc itself is CSS — a conic gradient for hue under a radial one for
// saturation. No canvas: nothing here needs to read pixels back, because the
// hue and saturation of a click are geometry, and geometry is exact where
// sampling a rendered gradient would be a guess about somebody's colour
// management.

import React, { useEffect, useRef, useState } from 'react';
import { hsvToRgb, rgbHex, rgbToHsv } from '../../../shared/color.ts';

/** Warm to cool, at the saturations these actually read at on a rig. A tint
 *  at full saturation is not a tint, it is a colour. */
const TINTS: { h: number; s: number; name: string }[] = [
  { h: 28, s: 0.55, name: 'candle' },
  { h: 32, s: 0.34, name: 'tungsten' },
  { h: 38, s: 0.18, name: 'warm white' },
  { h: 0, s: 0, name: 'white' },
  { h: 205, s: 0.14, name: 'cool white' },
  { h: 210, s: 0.3, name: 'daylight' },
  { h: 218, s: 0.5, name: 'moonlight' },
];

/** Hue is measured clockwise from twelve o'clock, which is where the conic
 *  gradient starts. Keeping the two in one place is what stops the marker
 *  drifting away from the colour under it. */
function pointFor(h: number, s: number): { left: string; top: string } {
  const a = (h * Math.PI) / 180;
  return {
    left: `${50 + Math.sin(a) * s * 50}%`,
    top: `${50 - Math.cos(a) * s * 50}%`,
  };
}

function pickAt(el: HTMLElement, clientX: number, clientY: number): { h: number; s: number } {
  const r = el.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  const radius = Math.min(r.width, r.height) / 2;
  const h = (((Math.atan2(dx, -dy) * 180) / Math.PI) % 360 + 360) % 360;
  const s = radius > 0 ? Math.min(1, Math.hypot(dx, dy) / radius) : 0;
  return { h, s };
}

export function ColourWheel({ h, s, onPick, onClose, anchor }: {
  h: number;
  s: number;
  /** the same route a swatch takes, so a ridden colour stays ridden */
  onPick: (h: number, s: number) => void;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const discRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [hex, setHex] = useState(() => rgbHex(...hsvToRgb(h, s, 1)));

  // Follow the value while the field is not being typed in, so dragging the
  // disc updates the hex and typing in the hex is not fought for the caret.
  const hexRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== hexRef.current) setHex(rgbHex(...hsvToRgb(h, s, 1)));
  }, [h, s]);

  useEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.left });
  }, [anchor]);

  // Measured and pulled into the window, the same as the calibration panel:
  // this opens from a chip near the right edge of a pane that scrolls.
  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(pos.left, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(pos.top, window.innerHeight - r.height - 8));
    if (Math.abs(left - pos.left) > 0.5 || Math.abs(top - pos.top) > 0.5) setPos({ top, left });
  }, [pos.left, pos.top]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  const drag = (e: React.PointerEvent) => {
    const el = discRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (x: number, y: number) => {
      const p = pickAt(el, x, y);
      onPick(p.h, p.s);
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const commitHex = () => {
    const t = hex.trim().replace(/^#/, '');
    const m = /^([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
    if (!m) {
      setHex(rgbHex(...hsvToRgb(h, s, 1)));
      return;
    }
    const full = t.length === 3 ? t.split('').map((c) => c + c).join('') : t;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    const [nh, ns] = rgbToHsv(r, g, b);
    // Value is thrown away on purpose: intensity is the dimmer's job, and a
    // dark hex would otherwise silently dim the part as well as colour it.
    onPick(nh, ns);
  };

  return (
    <>
      <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={onClose} />
      <div ref={boxRef} className="colourpop" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="colour">
        <div
          ref={discRef}
          className="huedisc"
          role="slider"
          aria-label="hue and saturation"
          aria-valuetext={`hue ${Math.round(h)} degrees, saturation ${Math.round(s * 100)} percent`}
          aria-valuenow={Math.round(h)}
          aria-valuemin={0}
          aria-valuemax={360}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={(e) => {
            // arrows walk the disc: hue round, saturation out and in
            const step = e.shiftKey ? 10 : 2;
            if (e.key === 'ArrowLeft') onPick((h - step + 360) % 360, s);
            else if (e.key === 'ArrowRight') onPick((h + step) % 360, s);
            else if (e.key === 'ArrowUp') onPick(h, Math.min(1, s + step / 100));
            else if (e.key === 'ArrowDown') onPick(h, Math.max(0, s - step / 100));
            else return;
            e.preventDefault();
          }}
        >
          <i className="huemark" style={pointFor(h, s)} />
        </div>
        <div className="row" style={{ gap: 6 }}>
          <i
            className="huecurrent"
            style={{ background: rgbHex(...hsvToRgb(h, s, 1)) }}
            aria-hidden="true"
          />
          <input
            ref={hexRef}
            className="text grow"
            value={hex}
            spellCheck={false}
            title="hex colour — brightness is ignored, because intensity is the dimmer's job"
            onChange={(e) => setHex(e.target.value)}
            onBlur={commitHex}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {TINTS.map((t) => (
            <i
              key={t.name}
              role="button"
              tabIndex={0}
              className="swatch tint"
              title={`${t.name} — a tint, not a colour: these sit where a white actually reads on a rig`}
              style={{ background: rgbHex(...hsvToRgb(t.h, t.s, 1)) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
              onClick={() => onPick(t.h, t.s)}
            />
          ))}
        </div>
        <span className="label">warm to cool</span>
      </div>
    </>
  );
}
