// An anchored menu, no veil (design 2.3, #19).
//
// `askChoice` puts a dark veil over the whole window, which during a song hides
// the pads that are playing behind the question "rename this look?". A menu is
// not a question about the show; it is a list of verbs for the thing under the
// pointer, and it belongs beside it.
//
// This is the library's own copy while #19 lifts one `Popover menu` component
// out for pads, heads, columns, songs and tiles. It is deliberately small: a
// position, a list, and the three ways a menu closes.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = {
  label: string;
  /** the hover, and the help card's sentence */
  title?: string;
  danger?: boolean;
  /** greyed, with `title` saying why */
  disabled?: boolean;
  run?: () => void;
};

export type MenuAt = { x: number; y: number };

/** Open one of these from a pointer event: `setAt({ x: e.clientX, y: e.clientY })`. */
export function Menu({ at, items, onClose }: { at: MenuAt; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // Flip back inside the window rather than off its edges — a menu opened on
  // the last tile of a bank is at the right edge by definition.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.max(pad, Math.min(at.x, window.innerWidth - r.width - pad)),
      y: Math.max(pad, Math.min(at.y, window.innerHeight - r.height - pad)),
    });
  }, [at]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Capture, so the menu closes before the click under it does anything.
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
  }, [onClose]);

  return (
    <div ref={ref} className="popover libmenu" style={{ top: pos.y, left: pos.x }} role="menu">
      {items.map((it, i) => (
        <button
          key={i}
          className={`btn small ghost ${it.danger ? 'danger' : ''}`}
          role="menuitem"
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            onClose();
            it.run?.();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
