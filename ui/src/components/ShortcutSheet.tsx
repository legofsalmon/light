// The keyboard and the pointer, on screen (backlog #8, design #37).
//
// One sheet, two tables, each rendered from the same list the app runs:
// ui/src/shortcuts.ts for the keys, ui/src/gestures.ts for the holds, drags and
// right-clicks. A binding cannot exist without appearing here — the drift this
// replaces was a guide claiming keys 1–8 fire columns long after the handler
// had grown to 9, and a pointer half that was never written down at all.
//
// The gesture column says what the pointer in this operator's hand does: a
// right-click on a mouse, a hold on glass, chosen by the same touch flag the
// rest of the app words its tooltips with.

import React, { useEffect } from 'react';
import { SHORTCUTS, SHORTCUT_GROUPS, plainKeys } from '../shortcuts.ts';
import { GESTURES, GESTURE_GROUPS, gestureWords } from '../gestures.ts';
import { useStore } from '../store.ts';
import { openExternal } from '../shell.ts';
import { GUIDE_URL } from '../links.ts';
import '../styles/band.css';

export function ShortcutSheet({ onClose }: { onClose: () => void }): React.ReactElement {
  const touch = useStore((s) => s.touch);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Escape and ? both close it — ? because the key that opened it is the
      // one a hand is already on.
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Everything else is swallowed. This dialog has no text fields, so
      // without it the cue keys behind it stay armed and reading the keyboard
      // reference fires cues — which is a joke a live rig does not find funny.
      // Tab still moves focus and Enter/Space still press the focused button,
      // because a dialog nobody can operate from the keyboard is a worse
      // answer than the problem.
      if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  return (
    <div
      className="modalveil"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal panel sheet" role="dialog" aria-modal="true" aria-label="Keys and gestures">
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <div className="modaltitle" style={{ flex: 1 }}>Keys and gestures</div>
          <button className="btn ghost small" onClick={onClose}>close</button>
        </div>
        <div className="modalbody" style={{ marginTop: 10 }}>
          <div className="sectionhead">Keys</div>
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <div className="label">{g}</div>
              <table className="tbl">
                <tbody>
                  {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                    <tr key={s.keys}>
                      <td style={{ width: 120 }}>
                        <span className="label" style={{ fontFamily: 'var(--mono)' }}>{plainKeys(s)}</span>
                      </td>
                      <td><span className="prose">{s.label}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="sectionhead">Gestures</div>
          {GESTURE_GROUPS.map((g) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <div className="label">{g}</div>
              <table className="tbl">
                <tbody>
                  {GESTURES.filter((x) => x.group === g).map((x) => (
                    <tr key={x.pointer}>
                      <td style={{ width: 220 }}>
                        <span className="prose">{gestureWords(x, touch)}</span>
                      </td>
                      <td><span className="prose">{x.label}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <span className="prose">
            Shortcuts are ignored while you are typing in a field. Press ? again, or Escape, to
            close this.
          </span>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn small" onClick={() => openExternal(GUIDE_URL)}>
              open the user guide
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
