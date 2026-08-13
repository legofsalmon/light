import React from 'react';
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
  const tab = useStore((s) => s.tab);
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
      <div className="tabbody">
        {tab === 'look' && <LookEditor />}
        {tab === 'patch' && <PatchView />}
        {tab === 'output' && <OutputView />}
        {tab === 'sync' && <SyncView />}
      </div>
    </>
  );
}
