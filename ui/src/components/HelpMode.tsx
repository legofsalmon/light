// The on-screen "?" (review M15). Every tooltip in the app is a hover, and a
// fingertip cannot hover — so on the tablet there was no help at all. With
// help mode on, a tap on any control shows the text its tooltip holds instead
// of operating it; tapping ? again, or Escape, ends it.
//
// The taps are swallowed at the document in the capture phase, above React's
// own listeners, because a pad fires on pointerdown: letting the event reach
// the grid to "see what it was" would put a look on stage.
//
// Help comes in two tiers (design #23): the hover is the first clause, the card
// is the whole sentence. `hoverTitle` cuts one from the other and `helpAttrs`
// puts both on a control — the card prefers `data-help` and falls back to the
// title, so a control that has not been split yet still reads correctly.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';

type Card = { label: string; text: string; rect: DOMRect };

/** what the card is allowed to ignore: itself, the ? that ends the mode, and
 *  any dialog — a dialog that is up must stay operable */
const passThrough = (t: EventTarget | null): boolean =>
  t instanceof Element && !!t.closest('.helpcard, .btn.help, .modalveil');

/** Help in two tiers (design #23).
 *
 *  A hover is read on the way past, usually with the other hand already on the
 *  pad: it gets the first clause and nothing else. The card — the ? tapped
 *  deliberately, or the tablet's only route to any help at all — gets the whole
 *  sentence, because someone reading it has stopped to read it.
 *
 *  The clause is everything before the first ` — ` or `. `, which is how every
 *  help string in this app is already written: the name, the dash, then what it
 *  does. A number never splits it — `0.3 s` has no space after the point — and a
 *  string with neither mark is short enough to be its own hover. */
export function hoverTitle(full: string): string {
  const dash = full.indexOf(' — ');
  const stop = full.indexOf('. ');
  const cuts = [dash, stop].filter((i) => i >= 0);
  return cuts.length ? full.slice(0, Math.min(...cuts)).trim() : full.trim();
}

/** The pair a control carries once the tiering is applied to it: the hover
 *  reads the clause, and the card reads `data-help` for the rest. Spread it
 *  where a `title=` is today — `<button {...helpAttrs('audition — …')}>`. */
export function helpAttrs(full: string): { title: string; 'data-help': string } {
  return { title: hoverTitle(full), 'data-help': full };
}

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
      const el = from?.closest<HTMLElement>('[data-help], [title], [aria-label]') ?? null;
      if (!el) {
        setCard(null); // empty space: put the card away
        return;
      }
      // The card is the long tier: `data-help` when the control carries both,
      // and the title when it is short enough to be its own hover.
      const text = el.getAttribute('data-help') || el.getAttribute('title') || el.getAttribute('aria-label') || '';
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
