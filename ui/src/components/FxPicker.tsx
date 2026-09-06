// The effects picker (backlog #4): the factory catalogue, with categories,
// search, and a preview that is the real thing rather than a drawing of it.
//
// Picking a preset applies it to the part immediately and leaves the picker
// open, so the next pick REPLACES it — you audition by clicking down the list
// and watching the stage. Keep closes on whatever is applied; Cancel takes it
// back out. Everything it writes is an ordinary look edit, so undo covers it
// either way and no new wire state exists to go stale.

import React, { useEffect, useRef, useState } from 'react';
import type { EffectTarget } from '../../../shared/types.ts';
import { FX_CATEGORIES, FX_LIBRARY, type FxCategory, type FxFactoryPreset, fxSearch, unusable } from '../fxLibrary.ts';
import { TARGET_LABEL, WAVE_LABEL } from '../labels.ts';

/** "sine · one bar" — the shape and the speed, which is what distinguishes two
 *  presets with the same idea. Beats per cycle read as musical time. */
function summarise(p: FxFactoryPreset): string {
  const r = p.effect.rate;
  const time =
    r >= 32 ? `${r / 4} bars`
    : r >= 8 ? `${r / 4} bars`
    : r === 4 ? 'a bar'
    : r === 2 ? 'half a bar'
    : r === 1 ? 'a beat'
    : `${r} of a beat`;
  return `${TARGET_LABEL[p.effect.target]} · ${WAVE_LABEL[p.effect.wave]} · ${time}`;
}

export function FxPicker({ capable, anchor, onPreview, onKeep, onCancel }: {
  /** targets something in this group can actually take */
  capable: ReadonlySet<EffectTarget>;
  /** the button that opened it, to hang the panel off */
  anchor: React.RefObject<HTMLButtonElement | null>;
  /** apply this preset now, replacing whatever the last pick applied */
  onPreview: (p: FxFactoryPreset) => void;
  onKeep: () => void;
  /** take the previewed effect back out */
  onCancel: () => void;
}): React.ReactElement {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<FxCategory | 'all'>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const r = anchor.current?.getBoundingClientRect();
  // Above the button when there is no room below: the picker lives at the
  // bottom of a scrolling tab and would otherwise open off-screen.
  // Roughly what the panel needs: search, the category row, the list at its
  // cap, and the footer. Only used to choose a side, so an estimate is enough.
  const tall = Math.min(480, window.innerHeight * 0.46 + 160);
  const below = (r?.bottom ?? 0) + tall < window.innerHeight;
  const pos = r
    ? { top: below ? r.bottom + 4 : Math.max(8, r.top - tall - 4), left: Math.max(8, r.left) }
    : { top: 80, left: 80 };

  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    // Escape cancels — the same key that closes every other overlay, and the
    // one an operator hits when a preview is doing something alarming.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onCancel]);

  const list = fxSearch(cat === 'all' ? FX_LIBRARY : FX_LIBRARY.filter((p) => p.category === cat), q);

  return (
    <div ref={boxRef} className="fxpicker" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="effects">
      <div className="row" style={{ gap: 6 }}>
        <input
          ref={searchRef}
          className="text grow"
          placeholder="search effects"
          title="matches the name, the description and the category"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="label">{list.length}</span>
      </div>
      <div className="fxcats">
        <button className={`setupstep ${cat === 'all' ? 'next' : ''}`} onClick={() => setCat('all')}>
          <span className="label">All</span>
        </button>
        {FX_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`setupstep ${cat === c.id ? 'next' : ''}`}
            onClick={() => setCat(c.id)}
          >
            <span className="label">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="fxlist">
        {list.length === 0 && (
          <span className="prose">Nothing matches “{q}”. The catalogue is starting points, not every effect — build from “+ effect” for anything it does not cover.</span>
        )}
        {list.map((p) => {
          const cannot = unusable(p, capable);
          return (
            <button
              key={p.id}
              className={`fxitem ${picked === p.id ? 'on' : ''}`}
              title={cannot ? `${p.description}\n\nNothing in this group takes ${TARGET_LABEL[p.effect.target]}, so this would do nothing here.` : p.description}
              onClick={() => { setPicked(p.id); onPreview(p); }}
            >
              <span className="fxname">
                {p.name}
                {cannot && <span className="label" style={{ color: 'var(--color-status-nudge)' }}> ⚠</span>}
              </span>
              <span className="label">{summarise(p)}</span>
              <span className="prose">{p.description}</span>
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <span className="label grow">
          {picked ? 'playing on this part — pick another to swap it' : 'pick one to hear it on the rig'}
        </span>
        <button className="btn small ghost" title="take the previewed effect back out and close" onClick={onCancel}>
          cancel
        </button>
        <button className="btn small" title="close and keep what is playing" onClick={onKeep}>
          keep
        </button>
      </div>
    </div>
  );
}
