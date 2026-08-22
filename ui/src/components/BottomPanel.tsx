import React, { useEffect, useRef } from 'react';
import { useStore, type Tab } from '../store.ts';
import { LookEditor } from './LookEditor.tsx';
import { PatchView } from './PatchView.tsx';
import { OutputView } from './OutputView.tsx';
import { SyncView } from './SyncView.tsx';
import { ControlsView } from './ControlsView.tsx';

const TABS: { id: Tab; label: string; help: string }[] = [
  { id: 'look', label: 'Look', help: 'edit the selected pad: parts, colour, position, beam and effects' },
  { id: 'patch', label: 'Fixtures', help: 'the patch — addresses, profiles, positions, groups, and GDTF/MVR import' },
  { id: 'controls', label: 'Controls', help: 'macro faders and their links, and the beat-locked modulators' },
  { id: 'output', label: 'Output', help: 'universes, Art-Net and sACN, and a live DMX monitor' },
  { id: 'sync', label: 'Sync · MIDI', help: 'tempo, Ableton Link, OSC from Resolume, and MIDI mappings' },
];

export function BottomPanel() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const tab = useStore((s) => s.tab);
  // each tab starts at the top — otherwise the Look editor opens
  // pre-scrolled with its own header out of view
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);
  const setTab = useStore((s) => s.setTab);
  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} title={t.help} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="tabbody" ref={bodyRef}>
        {tab === 'look' && <LookEditor />}
        {tab === 'patch' && <PatchView />}
        {tab === 'controls' && <ControlsView />}
        {tab === 'output' && <OutputView />}
        {tab === 'sync' && <SyncView />}
      </div>
    </>
  );
}
