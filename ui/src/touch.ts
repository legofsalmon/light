// Touch routes for what a fingertip cannot do (review M15).
//
// A right-click and a hover have no touch equivalent, so anything that lived
// only there — column rename/insert/delete, the song menu, removing a stage
// prop — is also reached by a long-press: hold for half a second without
// moving and the same menu opens. Mouse pointers are deliberately left alone:
// they keep right-click, and a slow click must never turn into a menu.
//
// State lives in a WeakMap keyed by the element, not in a closure: the grid
// re-renders on every fade frame, and a timer captured by one render would be
// lost before the finger lifted.

import type React from 'react';

export const LONG_PRESS_MS = 500;
/** a finger wobbles; a swipe does not */
const SLOP_PX = 8;
/** how long after opening the menu the click that follows is still its echo */
const ECHO_MS = 1500;

type Press = { timer: ReturnType<typeof setTimeout> | null; x: number; y: number; openedAt: number };
const presses = new WeakMap<Element, Press>();

const cancel = (el: Element) => {
  const p = presses.get(el);
  if (p?.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
};

export type ContextPressHandlers = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onClickCapture: (e: React.MouseEvent<HTMLElement>) => void;
};

/** Handlers that open an element's context action from a right-click OR a
 *  long-press (touch and pen only). Spread them onto the element; keep its
 *  own onClick — the click that trails a long-press is swallowed here, so
 *  holding a column head opens its menu without also firing the column. */
export function contextPress(open: () => void): ContextPressHandlers {
  const fire = (el: Element) => {
    const p = presses.get(el) ?? { timer: null, x: 0, y: 0, openedAt: 0 };
    p.timer = null;
    p.openedAt = performance.now();
    presses.set(el, p);
    open();
  };
  return {
    onPointerDown: (e) => {
      if (e.button !== 0 || e.pointerType === 'mouse') return;
      const el = e.currentTarget;
      cancel(el);
      const p: Press = { timer: null, x: e.clientX, y: e.clientY, openedAt: presses.get(el)?.openedAt ?? 0 };
      p.timer = setTimeout(() => fire(el), LONG_PRESS_MS);
      presses.set(el, p);
    },
    onPointerMove: (e) => {
      const p = presses.get(e.currentTarget);
      if (p?.timer && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) cancel(e.currentTarget);
    },
    onPointerUp: (e) => cancel(e.currentTarget),
    onPointerCancel: (e) => cancel(e.currentTarget),
    onPointerLeave: (e) => cancel(e.currentTarget),
    onContextMenu: (e) => {
      e.preventDefault();
      const el = e.currentTarget;
      // Android raises contextmenu from its own long-press; if ours already
      // opened the menu this is the same hold, not a second request
      const p = presses.get(el);
      if (p && performance.now() - p.openedAt < ECHO_MS) return;
      cancel(el);
      fire(el);
    },
    onClickCapture: (e) => {
      const p = presses.get(e.currentTarget);
      if (p && p.openedAt && performance.now() - p.openedAt < ECHO_MS) {
        p.openedAt = 0;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
}

/** True when the browser says the primary pointer is a fingertip. */
export const coarsePointer = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};
