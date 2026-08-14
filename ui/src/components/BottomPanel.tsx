import React, { useEffect, useRef } from 'react';
import { useStore, type Tab } from '../store.ts';
import { LookEditor } from './LookEditor.tsx';
import { PatchView } from './PatchView.tsx';
import { OutputView } from './OutputView.tsx';
import { SyncView } from './SyncView.tsx';

const TABS: { id: Tab; label: string }[] = [
  { id: 'look', label: 'Look' },
  { id: 'patch', label: 'Fixtures' },
  { id: 'output', label: 'Output' },
  { id: 'sync', label: 'Sync · MIDI' },
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
          <div key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="tabbody" ref={bodyRef}>
        {tab === 'look' && <LookEditor />}
        {tab === 'patch' && <PatchView />}
        {tab === 'output' && <OutputView />}
        {tab === 'sync' && <SyncView />}
      </div>
    </>
  );
}
