import React, { useEffect, useRef, useState } from 'react';
import { WS_PORT } from '../../shared/types.ts';
import { useStore, type BandView, type ViewMode } from './store.ts';
import { DialogHost } from './dialog.tsx';
import { TopBar } from './components/TopBar.tsx';
import { LookGrid } from './components/LookGrid.tsx';
import { BottomPanel } from './components/BottomPanel.tsx';
import { PrevizPanel } from './components/PrevizPanel.tsx';
import { LookLibrary } from './components/LookLibrary.tsx';
import { EditorPane } from './components/EditorPane.tsx';
import { LicenceGate } from './components/LicenceGate.tsx';
import { licenceAvailable, licenceStatus, type LicenceStatus } from './licence.ts';

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
            title="rebuild this panel — the rest of the console kept running, and nothing on stage changed"
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
  const view = useStore((s) => s.view);
  const previzHidden = useStore((s) => s.previzHidden);
  const togglePreviz = useStore((s) => s.togglePreviz);
  const libraryHiddenPref = useStore((s) => s.libraryHidden);
  const setLibraryHidden = useStore((s) => s.setLibraryHidden);
  const editorHiddenPref = useStore((s) => s.editorHidden);
  const setEditorHidden = useStore((s) => s.setEditorHidden);
  // The engine serves this same UI to a phone on the floor, where a side panel
  // and the grid cannot both fit and the grid's sticky layer head would cover
  // every pad. Track the width and let the pads win: a panel that has no room
  // folds to its strip whatever the saved preference says.
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const libraryFits = winW >= LIBRARY_MIN_WINDOW;
  const editorFits = winW >= EDITOR_MIN_WINDOW;
  const roomForBoth = winW >= BOTH_PANELS_MIN_WINDOW;
  let libraryHidden = libraryHiddenPref || !libraryFits;
  let editorHidden = editorHiddenPref || !editorFits;
  // Both wanted but only one fits: the library stays, because dragging a look
  // onto a pad is what this view is for and the editor has a whole other home.
  if (!libraryHidden && !editorHidden && !roomForBoth) editorHidden = true;
  // Revealing a panel that cannot sit beside its neighbour folds the neighbour
  // instead of doing nothing — a strip you can tap must always answer.
  const revealLibrary = () => {
    if (!roomForBoth && !editorHidden) setEditorHidden(true);
    setLibraryHidden(false);
  };
  const revealEditor = () => {
    if (!roomForBoth && !libraryHidden) setLibraryHidden(true);
    setEditorHidden(false);
  };
  const sidePanels: (keyof Layout)[] = [
    ...(libraryHidden ? [] : ['libraryW' as const]),
    ...(editorHidden ? [] : ['editorW' as const]),
  ];
  const [layout, setLayout] = useState(loadLayout);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStalled(true), 8000);
    return () => clearTimeout(t);
  }, []);
  // Asked once, over the Tauri bridge rather than the socket, so it answers
  // even though no engine is listening. A browser or the LAN tablet has no
  // bridge and never sees a gate — they are not the machine running the show.
  const [gate, setGate] = useState<LicenceStatus | null>(null);
  useEffect(() => {
    if (!licenceAvailable()) return;
    licenceStatus().then(setGate).catch(() => setGate(null));
  }, []);
  // The previz rides across the top of every view (rigs are wider than tall);
  // each view remembers its own hide state, and the full-screen previz view is
  // never hidden — it IS the previz.
  const bandHidden = view !== 'previz' && previzHidden[view];
  const resize = (key: keyof Layout, delta: number) =>
    setLayout((l) => {
      // `keep` is the track under the operator's cursor: it wins, and the other
      // vertical track gives way. Without it a drag would fight itself.
      const next = clampLayout({ ...l, [key]: l[key] + delta }, { view, keep: key, bandHidden, panels: sidePanels });
      try { localStorage.setItem('layout', JSON.stringify(next)); } catch { /* non-essential */ }
      return next;
    });
  useEffect(() => {
    // read the view and hide state live — this listener is installed once
    const onResize = () =>
      setLayout((l: Layout) => {
        const st = useStore.getState();
        const w = window.innerWidth;
        const lib = !(st.libraryHidden || w < LIBRARY_MIN_WINDOW);
        const ed = !(st.editorHidden || w < EDITOR_MIN_WINDOW) && !(lib && w < BOTH_PANELS_MIN_WINDOW);
        return clampLayout(l, {
          view: st.view,
          bandHidden: st.view !== 'previz' && st.previzHidden[st.view as BandView],
          panels: [...(lib ? ['libraryW' as const] : []), ...(ed ? ['editorW' as const] : [])],
        });
      });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // A band sized in the pads view can be too tall for the split view, which
  // stacks an editor under the same grid — re-clamp on arrival rather than
  // rendering a squeezed pad row. Collapsing the band re-clamps too: the editor
  // may now stretch into the room the band was holding.
  const wasHidden = useRef(bandHidden);
  useEffect(() => {
    // Revealing the band is the editor giving back what it took while the band
    // was away, so the band's remembered height wins that one exchange. Every
    // other re-clamp splits the shortfall proportionally.
    const revealing = wasHidden.current && !bandHidden;
    wasHidden.current = bandHidden;
    setLayout((l) =>
      clampLayout(l, {
        view,
        bandHidden,
        panels: sidePanels,
        ...(revealing ? { keep: 'previzH' as const } : {}),
      }),
    );
  }, [view, bandHidden, libraryHidden, editorHidden]);

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
      // ⌥1..⌥4 switch layout. Alt rather than plain digits because 1-9 fire
      // columns, and a mis-hit that changes the layout mid-song is cheap while
      // a mis-hit that fires the wrong cue is not.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key >= '1' && e.key <= '4') {
        e.preventDefault();
        st.setView((['pads', 'previz', 'patch', 'split'] as const)[Number(e.key) - 1]);
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
          // clamp, don't wrap — matches deck_step in both engines
          const j = Math.max(0, Math.min(decks.length - 1, (i < 0 ? 0 : i) + (e.key === ']' ? 1 : -1)));
          if (j !== i) st.send({ type: 'switchDeck', deckId: decks[j].id });
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

  // Ahead of the splash on purpose. When the licence gate is closed the engine
  // was never started, so "connecting to engine…" would be true and useless —
  // the reason it will never connect is the thing worth showing.
  if (gate?.blocksNewSession) return <LicenceGate />;

  if (!hasProject) {
    return (
      <div className="splash">
        L I G H T
        {/* Which build is this? Unanswerable from the screen until now, which
            made "have I actually got the version with the fix?" a question you
            could only answer by digging in Finder. */}
        <div className="label" style={{ letterSpacing: '0.18em', opacity: 0.55 }}>
          v{__APP_VERSION__}
        </div>
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
      className={`app view-${view} ${bandHidden ? 'previz-off' : ''}`}
      style={{
        ['--previz-h' as string]: `${layout.previzH}px`,
        ['--bottom-h' as string]: `${layout.bottomH}px`,
        // A collapsed side panel is an 18px strip in the same grid column, and
        // its splitter track goes to zero — one pads template covers every
        // combination instead of a class per permutation.
        ['--library-w' as string]: libraryHidden ? '18px' : `${layout.libraryW}px`,
        ['--lsplit-w' as string]: libraryHidden ? '0px' : '6px',
        ['--editor-w' as string]: editorHidden ? '18px' : `${layout.editorW}px`,
        ['--esplit-w' as string]: editorHidden ? '0px' : '6px',
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
      {/* Unmounted, not hidden — for the collapsed band too. A previz left
          mounted behind another panel keeps its requestAnimationFrame loop and
          its WebGL context running for a view nobody is looking at — on a
          laptop driving a show that is real battery and real GPU. Its teardown
          disposes the scene, the rig and the renderer, and the camera is
          persisted, so coming back restores the same view. */}
      {!bandHidden && (
        <div className="previz">
          {/* The audition pane rides the band's right edge — except while
              patching, where the whole band is the plan you drag fixtures
              into and nothing is selected for audition anyway. */}
          <Region name="previz"><PrevizPanel preview={view !== 'patch'} /></Region>
        </div>
      )}
      {bandHidden && (
        <div
          className="previzstrip"
          title="show the previz (hidden in this view only)"
          onClick={() => togglePreviz(view)}
        >
          <span className="label">previz ▾</span>
        </div>
      )}
      {view !== 'previz' && !bandHidden && (
        <Splitter dir="h" area="psplit" onDrag={(d) => resize('previzH', d)} />
      )}
      {(view === 'split' || view === 'pads') && (
        <div className="gridwrap">
          <Region name="look grid"><LookGrid /></Region>
        </div>
      )}
      {view === 'pads' && !libraryHidden && (
        <Splitter dir="v" area="lsplit" onDrag={(d) => resize('libraryW', -d)} />
      )}
      {view === 'pads' && !libraryHidden && (
        <div className="library panel">
          <Region name="look library"><LookLibrary /></Region>
        </div>
      )}
      {view === 'pads' && libraryHidden && (
        <div
          className="librarystrip"
          title={
            libraryFits
              ? 'show the look library'
              : 'the look library needs a wider window than this — the pads keep the width here'
          }
          onClick={() => libraryFits && revealLibrary()}
        >
          <span className="label">looks ◂</span>
        </div>
      )}
      {/* The look editor as a column: build the next song without leaving the
          surface you perform from. Same component as the bottom panel's Look
          tab — one editor, two homes. */}
      {view === 'pads' && !editorHidden && (
        <Splitter dir="v" area="esplit" onDrag={(d) => resize('editorW', -d)} />
      )}
      {view === 'pads' && !editorHidden && (
        <div className="editorpane panel">
          <Region name="look editor"><EditorPane /></Region>
        </div>
      )}
      {view === 'pads' && editorHidden && (
        <div
          className="editorstrip"
          title={
            editorFits
              ? 'show the look editor'
              : 'the look editor needs a wider window than this — the pads keep the width here'
          }
          onClick={() => editorFits && revealEditor()}
        >
          <span className="label">editor ◂</span>
        </div>
      )}
      {view === 'split' && <Splitter dir="h" area="hsplit" onDrag={(d) => resize('bottomH', -d)} />}
      {(view === 'split' || view === 'patch') && (
        <div className="bottom panel">
          <Region name="bottom panel"><BottomPanel /></Region>
        </div>
      )}
      <DialogHost />
    </div>
  );
}

type Layout = { previzH: number; bottomH: number; libraryW: number; editorW: number };

/** Floors, and the fixed furniture around the adjustable tracks.
 *  MIN_GRID/MIN_PANEL are vertical (the split view stacks band + pads +
 *  editor); MIN_GRID_W and the panel widths are horizontal (the pads view puts
 *  the library and the look editor beside the grid). A layer head is 168px and
 *  sticks to the left edge, so a grid narrower than MIN_GRID_W is a head
 *  covering its own pads. */
const MIN_GRID = 140;
const MIN_PANEL = 150;
const MIN_GRID_W = 290;
const MIN_LIBRARY = 200;
const MIN_EDITOR = 300;
const SPLIT_CHROME = 46 + 6 + 6 + 6;
const SPLIT_CHROME_BANDLESS = 46 + 18 + 6 + 5;
/** Window widths below which a pads-view side panel cannot be shown at all —
 *  its own floor plus a usable grid does not fit. */
const LIBRARY_MIN_WINDOW = MIN_GRID_W + MIN_LIBRARY + 8;
const EDITOR_MIN_WINDOW = MIN_GRID_W + MIN_EDITOR + 8;
const BOTH_PANELS_MIN_WINDOW = MIN_GRID_W + MIN_LIBRARY + MIN_EDITOR + 16;

/** Take `over` px off the tracks in `order`, each down to its floor, stopping
 *  when the debt is paid. The track under the operator's cursor is asked LAST,
 *  so a drag keeps following the pointer while anything else can still give;
 *  when everything is floored the loop simply runs out and the drag stops,
 *  rather than the grid between them paying for it. */
const absorb = (
  out: Layout,
  order: (keyof Layout)[],
  floor: number,
  over: number,
): void => {
  for (const key of order) {
    if (over <= 0) break;
    const give = Math.min(over, out[key] - floor);
    out[key] -= give;
    over -= give;
  }
};

/** Fit the saved sizes to the window.
 *
 *  `view` matters because the two axes are only constrained where the panels
 *  actually stack: vertically in the split view (band + pads + editor), and
 *  horizontally in the pads view (grid + library + look editor). Clamping each
 *  track on its own lets their SUM eat the grid between them and push the last
 *  panel off a viewport with no scrollbar to get it back. `keep` names the
 *  track being dragged — the one that wins. `panels` lists the pads-view side
 *  panels currently on screen; a collapsed one costs 18px, not its width. */
const clampLayout = (
  l: Layout,
  opts: {
    view?: ViewMode;
    keep?: keyof Layout;
    bandHidden?: boolean;
    panels?: (keyof Layout)[];
  } = {},
): Layout => {
  const out: Layout = {
    // the band must leave working room below it, whatever the window size
    previzH: Math.min(Math.max(l.previzH, MIN_PANEL), Math.max(180, window.innerHeight - 420)),
    bottomH: Math.min(Math.max(l.bottomH, MIN_PANEL), Math.max(200, window.innerHeight - 320)),
    libraryW: Math.max(l.libraryW, MIN_LIBRARY),
    editorW: Math.max(l.editorW, MIN_EDITOR),
  };

  if (opts.view === 'split' && opts.bandHidden) {
    // A collapsed band costs an 18px strip, not its remembered height. Reserving
    // that height anyway would dead-end the editor drag well short of the room
    // on screen — and worse, draining previzH to pay for it would destroy the
    // band size the operator set, which they only see when it comes back.
    const room = window.innerHeight - SPLIT_CHROME_BANDLESS - MIN_GRID;
    out.bottomH = Math.min(out.bottomH, Math.max(MIN_PANEL, room));
  } else if (opts.view === 'split') {
    const room = window.innerHeight - SPLIT_CHROME - MIN_GRID;
    let over = out.previzH + out.bottomH - room;
    if (over > 0) {
      if (!opts.keep) {
        // No drag in progress (window resize, view switch): take it off both in
        // proportion first, so neither panel collapses because the window
        // shrank. Flooring can leave a remainder — absorb() finishes it.
        const k = Math.max(0, room) / (out.previzH + out.bottomH);
        out.previzH = Math.max(MIN_PANEL, Math.floor(out.previzH * k));
        out.bottomH = Math.max(MIN_PANEL, Math.floor(out.bottomH * k));
        over = out.previzH + out.bottomH - room;
      }
      absorb(out, opts.keep === 'previzH' ? ['bottomH', 'previzH'] : ['previzH', 'bottomH'], MIN_PANEL, over);
    }
  }

  if (opts.view === 'pads') {
    // Same reasoning, sideways: the library and the look editor share what is
    // left of the width after the grid keeps MIN_GRID_W.
    const panels = opts.panels ?? [];
    const shown = panels.filter((p) => p === 'libraryW' || p === 'editorW');
    if (shown.length > 0) {
      const room = window.innerWidth - MIN_GRID_W - shown.length * 7;
      const total = shown.reduce((n, k) => n + out[k], 0);
      const over = total - room;
      if (over > 0) {
        const order = shown.length === 2
          ? (opts.keep === 'libraryW' ? ['editorW', 'libraryW'] : ['libraryW', 'editorW'])
          : shown;
        // floors differ per panel, so absorb one at a time
        let debt = over;
        for (const key of order as (keyof Layout)[]) {
          if (debt <= 0) break;
          const floor = key === 'libraryW' ? MIN_LIBRARY : MIN_EDITOR;
          const give = Math.min(debt, out[key] - floor);
          out[key] -= give;
          debt -= give;
        }
      }
    }
  }
  // On a window below the sum of the floors nothing usable fits either way, and
  // the floors keep every panel operable rather than collapsing one to nothing.
  return out;
};

function loadLayout(): Layout {
  // Field-by-field: a layout saved before the previz moved to the top band has
  // previzW/bottomH only — keep what still applies, default the rest.
  let saved: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem('layout') ?? 'null');
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch { /* defaults below */ }
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return clampLayout({
    previzH: num(saved.previzH, Math.round(window.innerHeight * 0.32)),
    bottomH: num(saved.bottomH, 292),
    libraryW: num(saved.libraryW, 280),
    editorW: num(saved.editorW, 380),
  });
}

/** A 6 px grid-track drag handle; `onDrag` gets the pointer delta along its
 *  axis, `area` names the grid track it occupies. */
function Splitter({ dir, area, onDrag }: { dir: 'v' | 'h'; area: string; onDrag: (delta: number) => void }) {
  const [active, setActive] = useState(false);
  return (
    <div
      className={`${dir === 'v' ? 'vsplit' : 'hsplit'} ${active ? 'active' : ''}`}
      style={{ gridArea: area }}
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
