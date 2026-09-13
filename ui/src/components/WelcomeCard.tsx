// The first-run card (backlog #8, design #20).
//
// Shown once, ever, on the first launch that gets past the licence gate — and
// never again, whether it was read or dismissed. LIGHT opens on a demo show
// with a rig already patched, which is the right first impression and also a
// slightly confusing one: none of it is yours. This says so in three lines and
// points at the three things worth knowing next.
//
// Its first key used to open the setup steps ON THE DEMO — five steps already
// ticked off by somebody else's rig, which is the opposite of a first step. It
// now runs the same flow the project menu does: name a show, make it, and open
// the Rig page on the bare project, where the steps have something to tick.
// Cancelling the name puts you back on the card, unseen, because a cancelled
// gesture must not spend the one showing this card gets.
//
// Deliberately not a tour. A modal that walks someone through a console they
// have not decided to learn yet is a modal they click through.

import React from 'react';
import { useStore } from '../store.ts';
import { openExternal } from '../shell.ts';
import { askPrompt } from '../dialog.tsx';
import { onEngineHost } from '../lockStore.ts';
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
  const done = () => {
    markSeen();
    onClose();
  };

  // A client that arrived over the network is not being introduced to a console
  // it might set up — it is being told what it is looking at. Never "set up my
  // own rig": there is a rig, on the Mac, and this is its remote.
  if (!onEngineHost()) {
    return (
      <div className="modalveil" onPointerDown={(e) => { if (e.target === e.currentTarget) done(); }}>
        <div className="modal panel" role="dialog" aria-modal="true" aria-label="Welcome to LIGHT">
          <div className="modaltitle">This is LIGHT</div>
          <div className="modalbody" style={{ marginTop: 'var(--space-10)' }}>
            <span className="prose" style={{ display: 'block' }}>
              This is the show running on the Mac — the same pads, live, over the network.
            </span>
            <span className="prose" style={{ display: 'block', marginTop: 'var(--space-6)' }}>
              Locked to the pads; hold the lock to unlock.
            </span>
            <div className="row" style={{ gap: 'var(--space-8)', marginTop: 'var(--space-14)', flexWrap: 'wrap' }}>
              <button className="btn" onClick={done}>
                got it
              </button>
              <button className="btn ghost" onClick={() => openExternal(GUIDE_URL)}>
                read the guide
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modalveil" onPointerDown={(e) => { if (e.target === e.currentTarget) done(); }}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label="Welcome to LIGHT">
        <div className="modaltitle">This is LIGHT</div>
        <div className="modalbody" style={{ marginTop: 'var(--space-10)' }}>
          <span className="prose">
            A lighting console that runs beside Resolume. Rows are layers, columns are the
            sections of a song, and each pad holds a look. Click a pad to fire it, or a column
            header to fire the whole column as a cue.
          </span>
          <span className="prose" style={{ display: 'block', marginTop: 'var(--space-10)' }}>
            What is open now is a demo show with a rig already patched, so there is something to
            press. Nothing is reaching a real rig: LIGHT starts <b>offline</b> every time and
            sends nothing until you say so.
          </span>
          <div className="row" style={{ gap: 'var(--space-8)', marginTop: 'var(--space-14)', flexWrap: 'wrap' }}>
            <button
              className="btn"
              title="name a show of your own, then open the Rig page on it — the setup steps tick themselves off as you go"
              onClick={() => {
                void (async () => {
                  const name = await askPrompt('New project', '', { placeholder: 'project name' });
                  // Cancelled: back to the card, and this launch still counts
                  // as not having seen it.
                  if (!name) return;
                  const st = useStore.getState();
                  st.send({ type: 'newProject', name });
                  st.setView('patch');
                  done();
                })();
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
          <span className="prose" style={{ display: 'block', marginTop: 'var(--space-12)' }}>
            Press <b>?</b> for the keyboard at any time. Every control has a tooltip.
          </span>
        </div>
      </div>
    </div>
  );
}
