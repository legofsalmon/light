// The first-run card (backlog #8).
//
// Shown once, ever, on the first launch that gets past the licence gate — and
// never again, whether it was read or dismissed. LIGHT opens on a demo show
// with a rig already patched, which is the right first impression and also a
// slightly confusing one: none of it is yours. This says so in three lines and
// points at the three things worth knowing next.
//
// Deliberately not a tour. A modal that walks someone through a console they
// have not decided to learn yet is a modal they click through.

import React from 'react';
import { useStore } from '../store.ts';
import { openExternal } from '../shell.ts';
import { GUIDE_URL } from '../links.ts';

const SEEN = 'light.welcomeSeen';

/** Has this Mac ever got past the first-run card?
 *
 *  localStorage, not the project: it is about the person, not the show, and a
 *  show that carried it would show the card again on every machine it was
 *  opened on. A private window or cleared site data means someone sees it
 *  twice, which is the harmless direction. */
export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return true; // storage blocked: never nag rather than nag every launch
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    // nothing to do: the card simply appears again next launch
  }
}

export function WelcomeCard({ onClose }: { onClose: () => void }): React.ReactElement {
  const setSetupGuide = useStore((s) => s.setSetupGuide);
  const done = () => {
    markSeen();
    onClose();
  };
  return (
    <div className="modalveil" onPointerDown={(e) => { if (e.target === e.currentTarget) done(); }}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label="Welcome to LIGHT">
        <div className="modaltitle">This is LIGHT</div>
        <div className="modalbody" style={{ marginTop: 10 }}>
          <span className="prose">
            A lighting console that runs beside Resolume. Rows are layers, columns are the
            sections of a song, and each pad holds a look. Click a pad to fire it, or a column
            header to fire the whole column as a cue.
          </span>
          <span className="prose" style={{ display: 'block', marginTop: 10 }}>
            What is open now is a demo show with a rig already patched, so there is something to
            press. Nothing is reaching a real rig: LIGHT starts <b>offline</b> every time and
            sends nothing until you say so.
          </span>
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              className="btn"
              title="the five things a rig needs before it lights, ticked off as you do them"
              onClick={() => {
                setSetupGuide(true);
                done();
              }}
            >
              set up my own rig
            </button>
            <button className="btn ghost" onClick={() => openExternal(GUIDE_URL)}>
              read the guide
            </button>
            <button className="btn ghost" title="or press ? at any time" onClick={done}>
              have a play
            </button>
          </div>
          <span className="prose" style={{ display: 'block', marginTop: 12 }}>
            Press <b>?</b> for the keyboard at any time. Every control has a tooltip.
          </span>
        </div>
      </div>
    </div>
  );
}
