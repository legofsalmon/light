// The on-screen "?" (review M15). Every tooltip in the app is a hover, and a
// fingertip cannot hover — so on the tablet there was no help at all. With
// help mode on, a tap on any control shows the text its tooltip holds instead
// of operating it; tapping ? again, or Escape, ends it.
//
// The taps are swallowed at the document in the capture phase, above React's
// own listeners, because a pad fires on pointerdown: letting the event reach
// the grid to "see what it was" would put a look on stage.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';

type Card = { label: string; text: string; rect: DOMRect };

/** what the card is allowed to ignore: itself, the ? that ends the mode, and
 *  any dialog — a dialog that is up must stay operable */
const passThrough = (t: EventTarget | null): boolean =>
  t instanceof Element && !!t.closest('.helpcard, .btn.help, .modalveil');

export function HelpOverlay(): React.ReactElement | null {
  const helpMode = useStore((s) => s.helpMode);
  const setHelpMode = useStore((s) => s.setHelpMode);
  const [card, setCard] = useState<Card | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!helpMode) {
      setCard(null);
      return;
    }
    const swallow = (e: Event) => {
      if (passThrough(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
    };
    const onDown = (e: PointerEvent) => {
      if (passThrough(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      const from = e.target instanceof Element ? e.target : null;
      const el = from?.closest<HTMLElement>('[title], [aria-label]') ?? null;
      if (!el) {
        setCard(null); // empty space: put the card away
        return;
      }
      const text = el.getAttribute('title') || el.getAttribute('aria-label') || '';
      const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const aria = el.getAttribute('aria-label') ?? '';
      const label = own && own.length <= 28 && own !== text ? own : aria && aria !== text ? aria : '';
      setCard({ label, text, rect: el.getBoundingClientRect() });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setHelpMode(false);
      }
    };
    const opts = { capture: true } as const;
    const swallowed = ['pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'];
    document.addEventListener('pointerdown', onDown, opts);
    for (const type of swallowed) document.addEventListener(type, swallow, opts);
    document.addEventListener('touchend', swallow, { capture: true, passive: false });
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, opts);
      for (const type of swallowed) document.removeEventListener(type, swallow, opts);
      document.removeEventListener('touchend', swallow, { capture: true });
      window.removeEventListener('keydown', onKey, true);
    };
  }, [helpMode, setHelpMode]);

  // Below the control when there is room, above it when there is not, and
  // never off the side of the screen.
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!card || !node) {
      setPos(null);
      return;
    }
    const { width, height } = node.getBoundingClientRect();
    const pad = 8;
    let top = card.rect.bottom + pad;
    if (top + height > window.innerHeight - pad) top = card.rect.top - height - pad;
    if (top < pad) top = pad;
    const left = Math.max(pad, Math.min(card.rect.left, window.innerWidth - width - pad));
    setPos({ top, left });
  }, [card]);

  if (!helpMode) return null;
  return (
    <>
      {card ? (
        <div
          ref={cardRef}
          className="helpcard"
          role="status"
          style={pos ? { top: pos.top, left: pos.left } : { top: 8, left: 8, visibility: 'hidden' }}
        >
          {card.label && <div className="label">{card.label}</div>}
          <div className="prose">{card.text}</div>
        </div>
      ) : (
        <div className="helpcard pill" role="status">
          <div className="prose">Help is on. Tap any control to read what it does. Tap ? again to stop.</div>
        </div>
      )}
    </>
  );
}
