import React, { useEffect, useState } from 'react';
import { WS_PORT } from '../../shared/types.ts';
import { useStore } from './store.ts';
import { DialogHost } from './dialog.tsx';
import { TopBar } from './components/TopBar.tsx';
import { LookGrid } from './components/LookGrid.tsx';
import { BottomPanel } from './components/BottomPanel.tsx';
import { PrevizPanel } from './components/PrevizPanel.tsx';

/** Keeps one crashing region from blanking the whole console mid-show: the
 *  grid, masters, and blackout survive a previz or editor exception. */
class Region extends React.Component<
  { name: string; children: React.ReactNode },
  { failed: boolean; nonce: number }
> {
  state = { failed: false, nonce: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error(`[light] ${this.props.name} crashed:`, error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="crashed">
          <span>{this.props.name} crashed</span>
          <button
            className="btn small ghost"
            onClick={() => this.setState((s) => ({ failed: false, nonce: s.nonce + 1 }))}
          >
            remount
          </button>
        </div>
      );
    }
    return <React.Fragment key={this.state.nonce}>{this.props.children}</React.Fragment>;
  }
}

export function App() {
  const hasProject = useStore((s) => !!s.project);
  const connected = useStore((s) => s.connected);
  const engineStalled = useStore((s) => s.engineStalled);
  const [layout, setLayout] = useState(loadLayout);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStalled(true), 8000);
    return () => clearTimeout(t);
  }, []);
  const resize = (key: 'previzW' | 'bottomH', delta: number) =>
    setLayout((l) => {
      const next = clampLayout({ ...l, [key]: l[key] + delta });
      try { localStorage.setItem('layout', JSON.stringify(next)); } catch { /* non-essential */ }
      return next;
    });
  useEffect(() => {
    const onResize = () => setLayout((l: { previzW: number; bottomH: number }) => clampLayout(l));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      // Held keys must not machine-gun cues/tap/blackout, and browser
      // shortcuts (⌘1 etc.) must not double as ours.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      // [ and ] step songs — the APC bank arrows do this, the keyboard should too
      if (e.key === '[' || e.key === ']') {
        const decks = st.project?.decks ?? [];
        if (decks.length > 1) {
          const i = decks.findIndex((d) => d.id === st.project?.activeDeckId);
          const n = decks.length;
          const next = decks[((i < 0 ? 0 : i) + (e.key === ']' ? 1 : -1) + n) % n];
          st.send({ type: 'switchDeck', deckId: next.id });
        }
        return;
      }
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
        {stalled && !connected && (
          <div className="label" style={{ maxWidth: 380, textAlign: 'center', lineHeight: 1.6 }}>
            The engine is not responding. Another copy of LIGHT (or other software) may be holding
            port {WS_PORT} — quit it and reopen, or check Console.app for “[light]” errors.
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="app"
      style={{
        ['--previz-w' as string]: `${layout.previzW}px`,
        ['--bottom-h' as string]: `${layout.bottomH}px`,
      }}
    >
      {(!connected || engineStalled) && (
        <div className="offlinebar">
          {connected
            ? 'ENGINE STALLED — connected, but the show engine has stopped responding'
            : 'ENGINE OFFLINE — reconnecting… nothing you press is reaching the rig'}
        </div>
      )}
      <Region name="top bar"><TopBar /></Region>
      <div className="gridwrap">
        <Region name="look grid"><LookGrid /></Region>
      </div>
      <Splitter dir="h" onDrag={(d) => resize('bottomH', -d)} />
      <div className="bottom panel">
        <Region name="bottom panel"><BottomPanel /></Region>
      </div>
      <Splitter dir="v" onDrag={(d) => resize('previzW', -d)} />
      <div className="previz">
        <Region name="previz"><PrevizPanel /></Region>
      </div>
      <DialogHost />
    </div>
  );
}

const clampLayout = (l: { previzW: number; bottomH: number }) => ({
  previzW: Math.min(Math.max(l.previzW, 280), Math.max(320, window.innerWidth - 560)),
  bottomH: Math.min(Math.max(l.bottomH, 150), Math.max(200, window.innerHeight - 320)),
});

function loadLayout(): { previzW: number; bottomH: number } {
  try {
    const saved = JSON.parse(localStorage.getItem('layout') ?? 'null');
    if (saved && Number.isFinite(saved.previzW) && Number.isFinite(saved.bottomH)) {
      return clampLayout(saved);
    }
  } catch { /* defaults below */ }
  return clampLayout({ previzW: Math.round(window.innerWidth * 0.27), bottomH: 292 });
}

/** A 6 px grid-track drag handle; `onDrag` gets the pointer delta along its axis. */
function Splitter({ dir, onDrag }: { dir: 'v' | 'h'; onDrag: (delta: number) => void }) {
  const [active, setActive] = useState(false);
  return (
    <div
      className={`${dir === 'v' ? 'vsplit' : 'hsplit'} ${active ? 'active' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        setActive(true);
        let last = dir === 'v' ? e.clientX : e.clientY;
        const onMove = (me: PointerEvent) => {
          if (!(me.buttons & 1)) {
            onUp(); // released outside the window — never stick to the cursor
            return;
          }
          const cur = dir === 'v' ? me.clientX : me.clientY;
          onDrag(cur - last);
          last = cur;
        };
        const onUp = () => {
          setActive(false);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }}
    />
  );
}
