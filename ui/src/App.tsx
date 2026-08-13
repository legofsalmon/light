import { useEffect } from 'react';
import { useStore } from './store.ts';
import { TopBar } from './components/TopBar.tsx';
import { LookGrid } from './components/LookGrid.tsx';
import { BottomPanel } from './components/BottomPanel.tsx';
import { PrevizPanel } from './components/PrevizPanel.tsx';

export function App() {
  const hasProject = useStore((s) => !!s.project);
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const st = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        st.send({ type: 'save' });
        return;
      }
      // Held keys must not machine-gun cues/tap/blackout, and browser
      // shortcuts (⌘1 etc.) must not double as ours.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= '1' && e.key <= '9') {
        const col = Number(e.key) - 1;
        if (st.project && col < st.project.columns.length) st.send({ type: 'column', col });
      } else if (e.key.toLowerCase() === 't') {
        st.send({ type: 'tap' });
      } else if (e.key.toLowerCase() === 'b') {
        st.send({ type: 'setBlackout', v: !st.snap?.blackout });
      } else if (e.key === 'Escape') {
        st.setSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!hasProject) {
    return (
      <div className="splash">
        L I G H T
        <div className="dot">{connected ? 'loading project…' : 'connecting to engine…'}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <div className="gridwrap">
        <LookGrid />
      </div>
      <div className="bottom panel">
        <BottomPanel />
      </div>
      <div className="previz">
        <PrevizPanel />
      </div>
    </div>
  );
}
