import React, { useEffect, useRef } from 'react';
import { useStore, type Tab } from '../store.ts';
import { LookEditor } from './LookEditor.tsx';
import { ControlsView } from './ControlsView.tsx';
import { RigView } from './rig/RigView.tsx';

/** Build's two tabs. Rig owns Fixtures and has no tab bar of its own (design
 *  2.9); Output and Sync · MIDI are the setup surface's (2.10), reached from
 *  the cog, the OFFLINE gate and any lamp — they are settings for the room,
 *  not a place you work. */
const TABS: { id: Tab; label: string; help: string }[] = [
  { id: 'look', label: 'Look', help: 'edit the selected pad: parts, colour, position, beam and effects' },
  { id: 'controls', label: 'Controls', help: 'dials and their links, and the beat-locked pulses' },
];

export function BottomPanel() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const view = useStore((s) => s.view);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  // each tab starts at the top — otherwise the Look editor opens pre-scrolled
  // with its own header out of view
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);

  // The Rig page IS the view: no tab bar, and it lays itself out in three
  // columns rather than scrolling inside a tab body.
  if (view === 'patch') return <RigView />;

  // A tab that has moved out of this panel — Fixtures to its own view, Output
  // and Sync to the setup surface — lands on the editor rather than on nothing.
  const shown: Tab = tab === 'controls' ? 'controls' : 'look';
  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`tab ${shown === t.id ? 'on' : ''}`}
            role="tab"
            aria-selected={shown === t.id}
            tabIndex={0}
            title={t.help}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t.id); } }}
          >
            {t.label}
          </div>
        ))}
      </div>
      <div className="tabbody" ref={bodyRef}>
        {shown === 'look' && <LookEditor />}
        {shown === 'controls' && <ControlsView />}
      </div>
    </>
  );
}
