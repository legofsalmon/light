// Notices, where the eye can find them: bottom-left, stacked, newest last.
//
// They used to be one 9.5px label in the top bar that the next notice replaced
// after five seconds and that a laptop scrolled out of reach — SAVE FAILED,
// "cannot open" and "N offline edits discarded" were the three messages most
// worth seeing and the three easiest to miss (review M4). Failures stay until
// dismissed; everything else expires. aria-live so a screen reader hears them.

import React from 'react';
import { useStore } from '../store.ts';

export function Toasts(): React.ReactElement | null {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.ok ? 'ok' : 'bad'}`}>
          <span className="toasttext">{t.text}</span>
          <button className="btn small ghost" title="dismiss" aria-label="dismiss" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
