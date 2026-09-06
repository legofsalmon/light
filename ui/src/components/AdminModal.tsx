// The cog: everything about running LIGHT that is not running a show.
//
// Updates and Licence used to live in the Output tab, which is the wrong home
// for them — Output is a live-rig screen (universes, Art-Net, the DMX monitor,
// channel check), things you reach for WITH a rig in front of you. A licence key
// and a version number are prep-room concerns and were sitting in the way.
//
// What deliberately did NOT move: anything you might touch during a set. Art-Net
// toggles, the DMX monitor and channel check stay in Output. The test of whether
// something belongs here is "would I ever open this with the house lights down?"
//
// Reuses dialog.tsx's veil and panel rather than inventing a second modal look,
// and copies its capture-phase key swallow — without that, typing a licence key
// fires cues on 1-9, tap on T and BLACKOUT on B, on the rig underneath.

import React, { useEffect } from 'react';
import { LicencePanel } from './LicencePanel.tsx';
import { UpdatePanel } from './UpdatePanel.tsx';
import { licenceAvailable } from '../licence.ts';
import { updateAvailable } from '../update.ts';
import { useStore, type TouchPref } from '../store.ts';

/** Touch sizing (review M14/M15). Auto follows what the browser says the
 *  pointer is; the override exists because a touchscreen laptop or a tablet
 *  with a trackpad reports whichever it feels like, and because a laptop on a
 *  flight case may want the bigger targets anyway. */
function TouchSetting(): React.ReactElement {
  const pref = useStore((s) => s.touchPref);
  const touch = useStore((s) => s.touch);
  const setTouchPref = useStore((s) => s.setTouchPref);
  const options: { v: TouchPref; label: string; title: string }[] = [
    { v: 'auto', label: 'auto', title: 'follow the pointer the browser reports: on for a fingertip, off for a mouse or trackpad' },
    { v: 'on', label: 'on', title: 'bigger targets, hold-to-edit and the ? help button, whatever the pointer' },
    { v: 'off', label: 'off', title: 'laptop density on this screen, whatever the pointer' },
  ];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <span className="label" style={{ width: 90 }}>touch sizing</span>
        <div className="seg" role="group" aria-label="touch sizing">
          {options.map((o) => (
            <button key={o.v} className={pref === o.v ? 'on' : ''} title={o.title} onClick={() => setTouchPref(o.v)}>
              {o.label}
            </button>
          ))}
        </div>
        <span className="label">{touch ? 'on now' : 'off now'}</span>
      </div>
      <div className="prose">
        Every control grows to at least 24px, a song or column can be edited by holding it, and a ? in the
        top bar explains any control you tap. Auto follows the pointer: on for a fingertip, off for a mouse or
        trackpad.
      </div>
    </div>
  );
}

export function AdminModal({ onClose }: { onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // The whole reason this is capture-phase: App's global hotkeys are a
      // bubble listener on window, and they only bail for INPUT/SELECT/TEXTAREA.
      // Click the panel background, type a B, and the rig goes dark.
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const anything = updateAvailable() || licenceAvailable();

  return (
    <div
      className="modalveil"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal panel wide" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <div className="modaltitle" style={{ flex: 1 }}>
            Settings
          </div>
          <button className="btn ghost small" onClick={onClose}>
            close
          </button>
        </div>

        {/* Shown everywhere, browser and tablet included — the tablet is
            exactly where this one matters. */}
        <div style={{ marginTop: 12 }}>
          <div className="sectionhead">Display</div>
          <TouchSetting />
        </div>

        {anything ? (
          <div className="col" style={{ gap: 18, marginTop: 18 }}>
            {updateAvailable() && (
              <div>
                <div className="sectionhead">Updates</div>
                <UpdatePanel />
              </div>
            )}
            {licenceAvailable() && (
              <div>
                <div className="sectionhead">Licence</div>
                <LicencePanel />
              </div>
            )}
          </div>
        ) : (
          // A browser or the LAN tablet has no Tauri bridge, so neither panel
          // can do anything. Say why rather than showing an empty box.
          <div className="modalbody" style={{ marginTop: 10 }}>
            Updates and licensing live in the LIGHT app on the machine running the show. This window
            is connected over the network, so there is nothing to manage from here.
          </div>
        )}
      </div>
    </div>
  );
}
