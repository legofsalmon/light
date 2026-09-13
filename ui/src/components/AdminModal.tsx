// The setup surface (design 2.10): one sheet, reached from ⚙, the OFFLINE
// gate, a status lamp, the DIALS head's controller menu and ⌘,.
//
// Output · Sync · MIDI · Display · Lock · Licence · Updates · Help, with a rail
// down the left and ONE section open at a time. Seven panels stacked in a 680px
// sheet would be a scroll with no landmarks, and the Output panel alone is a
// screen — it also opens a live DMX stream while it is mounted, which is reason
// enough not to mount it because somebody wanted the licence key.
//
// What deliberately did NOT move here: anything you might touch during a set.
// The test is "would I ever open this with the house lights down?" — the
// Fixtures table stays on the Rig page, and the pads stay where they are.
//
// Reuses dialog.tsx's veil and panel rather than inventing a second modal look,
// and copies its capture-phase key swallow — without that, typing a licence key
// fires cues on 1-9, tap on T and BLACKOUT on B, on the rig underneath.

import React, { useEffect } from 'react';
import { create } from 'zustand';
import { LicencePanel } from './LicencePanel.tsx';
import { UpdatePanel } from './UpdatePanel.tsx';
import { OutputView } from './OutputView.tsx';
import { SyncView, PresetUndoChip } from './SyncView.tsx';
import { LockBar } from './setup/LockBar.tsx';
import { licenceAvailable } from '../licence.ts';
import { updateAvailable, enginePort } from '../update.ts';
import { useStore, type TouchPref } from '../store.ts';
import { useLock, onEngineHost, lockedByDefault } from '../lockStore.ts';
import { askPrompt } from '../dialog.tsx';
import { openExternal } from '../shell.ts';
import { GUIDE_URL } from '../links.ts';
import { qrCode } from '../qr.ts';
import '../styles/setup.css';

export type SetupSection = 'output' | 'sync' | 'display' | 'lock' | 'licence' | 'updates' | 'help';

/** Open state lives in a store of its own so every entry point is one call —
 *  `openSetup('sync')` from the DIALS head, `openSetup('output')` from the
 *  OFFLINE gate or a lamp, `openSetup()` from the cog. */
const useSetup = create<{ open: boolean; section: SetupSection }>()(() => ({ open: false, section: 'output' }));

export function openSetup(section: SetupSection = 'output'): void {
  useSetup.setState({ open: true, section });
}
export function closeSetup(): void {
  useSetup.setState({ open: false });
}

/** The address a second device would type to reach this engine. Only ever
 *  shown on a client that already arrived over the network: inside the shell
 *  the page origin is `tauri://`, which says nothing about the LAN. */
function engineAddress(): string {
  try {
    if (location.protocol.startsWith('http')) return `${location.protocol}//${location.host}`;
  } catch { /* fall through */ }
  return `http://localhost:${enginePort()}`;
}

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
    <div className="col" style={{ gap: 'var(--space-8)' }}>
      <div className="row">
        <span className="label" style={{ width: 'var(--size-master-w-narrow)' }}>touch sizing</span>
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
        trackpad. Touch also arms the lock, because a screen you touch is a screen an elbow can touch.
      </div>
    </div>
  );
}

/** The engine's address in text/readout, and the same address as a code so a
 *  phone can be pointed at the screen instead of typing an IP in the dark. */
function AddressBlock(): React.ReactElement {
  const address = engineAddress();
  const code = qrCode(address);
  return (
    <div className="col" style={{ gap: 'var(--space-8)' }}>
      <div className="addressblock">
        {code ? (
          <svg className="qrcode" viewBox={`0 0 ${code.size} ${code.size}`} role="img" aria-label={`the address ${address} as a scannable code`}>
            <path d={code.path} />
          </svg>
        ) : null}
        <div className="col" style={{ gap: 'var(--space-4)' }}>
          <span className="address">{address}</span>
          <span className="prose">
            This window is talking to the show over the network. Any other browser on the same network
            reaches it at this address — point a phone at the code rather than typing it in the dark.
          </span>
        </div>
      </div>
    </div>
  );
}

/** Lock (design 2.11). Sets the passcode, states the default rule, and says
 *  plainly what the lock is and is not. */
function LockSection(): React.ReactElement {
  const passcode = useLock((s) => s.passcode);
  const setPasscode = useLock((s) => s.setPasscode);
  const touch = useStore((s) => s.touch);
  return (
    <div className="col" style={{ gap: 'var(--space-10)' }}>
      <LockBar />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="label" style={{ width: 'var(--size-master-w-narrow)' }}>passcode</span>
        <span className="label">{passcode ? 'set on this client' : 'none — a hold is the whole unlock'}</span>
        <button
          className="btn small"
          title="ask for a passcode after the hold. It is kept in this browser, so setting it here does not set it on the tablet."
          onClick={() => {
            void (async () => {
              const typed = await askPrompt(passcode ? 'Change the passcode' : 'Set a passcode', '', {
                body: 'Asked for after the hold, on this client only. A deterrent, not security.',
                placeholder: 'passcode',
                confirmLabel: 'Set',
              });
              if (typed) setPasscode(typed);
            })();
          }}
        >
          {passcode ? 'change' : 'set a passcode…'}
        </button>
        {passcode && (
          <button className="btn small ghost" title="back to a hold being the whole unlock" onClick={() => setPasscode(null)}>
            clear
          </button>
        )}
      </div>
      <div className="prose">
        Locked, this client is the pads and nothing else: pads, columns, songs, dials, groups, masters,
        blackout, all stop and freeze all work, and the Rig page does not open. It starts locked when
        touch sizing is on, or when this client is not the machine running the show —{' '}
        {onEngineHost() ? 'this one is the show’s own machine' : 'this one arrived over the network'}, and touch is{' '}
        {touch ? 'on' : 'off'}, so it {lockedByDefault() ? 'starts locked' : 'starts unlocked'}.
      </div>
      <div className="prose">
        Only the passcode is remembered. The unlocked state is not: a reload, a reconnect or thirty
        seconds untouched locks it again, so "on by default" holds at every show rather than until the
        first unlock.
      </div>
      <div className="prose">
        What this is: a way to keep a leaning elbow off the Rig page until the engine enforces a role of
        its own. What it is not: security. The passcode is held in this browser, and nothing here stops
        another program on the network sending the engine an edit.
      </div>
    </div>
  );
}

type SectionDef = { id: SetupSection; label: string; tag?: string; body: () => React.ReactElement };

function Sheet({ onClose, onOpenShortcuts }: {
  onClose: () => void;
  onOpenShortcuts?: () => void;
}): React.ReactElement {
  const section = useSetup((s) => s.section);
  const project = useStore((s) => s.project);
  const live = useStore((s) => s.snap?.transmit) === true;
  const locked = useLock((s) => s.locked);
  const setSetupGuide = useStore((s) => s.setSetupGuide);

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

  const sections: SectionDef[] = [
    { id: 'output', label: 'Output', tag: live ? 'live' : 'offline', body: () => <OutputView /> },
    { id: 'sync', label: 'Sync · MIDI', tag: project ? String(project.midi.length) : undefined, body: () => <SyncView /> },
    { id: 'display', label: 'Display', body: () => (
      <div className="col" style={{ gap: 'var(--space-14)' }}>
        <TouchSetting />
        {!onEngineHost() && <AddressBlock />}
      </div>
    ) },
    { id: 'lock', label: 'Lock', tag: locked ? 'locked' : 'open', body: () => <LockSection /> },
    ...(licenceAvailable() ? [{ id: 'licence' as const, label: 'Licence', body: () => <LicencePanel /> }] : []),
    ...(updateAvailable() ? [{ id: 'updates' as const, label: 'Updates', body: () => <UpdatePanel /> }] : []),
    { id: 'help', label: 'Help', body: () => (
      <div className="col" style={{ gap: 'var(--space-12)' }}>
        <div className="row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => openExternal(GUIDE_URL)}>
            user guide
          </button>
          <button
            className="btn small"
            title="every keyboard shortcut — also on the ? key"
            onClick={() => {
              onClose();
              onOpenShortcuts?.();
            }}
          >
            keyboard shortcuts
          </button>
        </div>
        {/* The setup steps open themselves on a show with no fixtures and can be
            sent away; this is how they come back, and how they are found at all
            on a show that was already set up. */}
        <div className="row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <button
            className="btn small"
            onClick={() => {
              setSetupGuide(true);
              onClose();
            }}
          >
            show the setup steps
          </button>
          <span className="prose">
            Output, fixtures, stage, groups and aim — what a rig needs before it lights,
            with each step ticked off by reading the show.
          </span>
        </div>
        {!updateAvailable() && !licenceAvailable() && (
          <div className="prose">
            Updates and licensing live in the LIGHT app on the machine running the show. This window is
            connected over the network, so there is nothing to manage from here.
          </div>
        )}
      </div>
    ) },
  ];
  const here = sections.find((s) => s.id === section) ?? sections[0];

  return (
    <div
      className="modalveil"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal panel wide" role="dialog" aria-modal="true" aria-label="Setup">
        <div className="row" style={{ alignItems: 'baseline', gap: 'var(--space-8)' }}>
          <div className="modaltitle" style={{ flex: 1 }}>
            Setup
          </div>
          <button className="btn ghost small" onClick={onClose}>
            close
          </button>
        </div>
        <div className="setupsheet">
          <div className="setupnav" role="tablist" aria-label="setup sections">
            {sections.map((s) => (
              <button
                key={s.id}
                className={`btn small ${s.id === here.id ? 'here' : ''}`}
                role="tab"
                aria-selected={s.id === here.id}
                onClick={() => useSetup.setState({ section: s.id })}
              >
                {s.label}
                {s.tag ? <span className="tag">{s.tag}</span> : null}
              </button>
            ))}
          </div>
          <div className="setupbody" role="tabpanel" aria-label={here.label}>
            {here.body()}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mount once, beside the app: it renders nothing until something opens it, and
 *  it carries the controller-layout undo chip, which has to outlive the sheet
 *  because the DIALS head can load a layout without ever opening one. */
export function SetupSheet({ onOpenShortcuts }: { onOpenShortcuts?: () => void }): React.ReactElement {
  const open = useSetup((s) => s.open);
  return (
    <>
      <PresetUndoChip />
      {open && <Sheet onClose={closeSetup} onOpenShortcuts={onOpenShortcuts} />}
    </>
  );
}

/** The cog's own call site, kept as it was so App needs no change to keep
 *  working: `{admin && <AdminModal onClose={…} onOpenShortcuts={…} />}`. */
export function AdminModal({ onClose, onOpenShortcuts }: {
  onClose: () => void;
  /** open the keyboard sheet — owned by App, so it can outlive this modal */
  onOpenShortcuts?: () => void;
}): React.ReactElement {
  return (
    <>
      <PresetUndoChip />
      <Sheet onClose={onClose} onOpenShortcuts={onOpenShortcuts} />
    </>
  );
}
