import React, { useEffect, useRef, useState } from 'react';
import { WS_PORT } from '../../shared/types.ts';
import { useStore, BUILD_OPENS, PADS_OPENS, type BandView, type ViewMode } from './store.ts';
import { runShortcut } from './shortcuts.ts';
import { DialogHost } from './dialog.tsx';
import { TopBar } from './components/TopBar.tsx';
import { LookGrid, headName } from './components/LookGrid.tsx';
import { BottomPanel } from './components/BottomPanel.tsx';
import { PrevizPanel } from './components/PrevizPanel.tsx';
import { LibrarySheet, LookLibrary } from './components/LookLibrary.tsx';
import { Find } from './components/Find.tsx';
import { EditorPane } from './components/EditorPane.tsx';
import { LicenceGate } from './components/LicenceGate.tsx';
import { licenceAvailable, licenceStatus, type LicenceStatus } from './licence.ts';
import { SetupSheet, openSetup } from './components/AdminModal.tsx';
import { Toasts } from './components/Toasts.tsx';
import { HelpOverlay } from './components/HelpMode.tsx';
import { SetupGuide } from './components/SetupGuide.tsx';
import { ShortcutSheet } from './components/ShortcutSheet.tsx';
import { WelcomeCard, welcomeSeen } from './components/WelcomeCard.tsx';
import { updateAvailable, updateStatus } from './update.ts';
import { size, sizeTouch, space } from './tokens.ts';
import { Glyph } from './glyphs.tsx';
import { APC_LAYER_ROWS } from './apcFeedback.ts';
import { Fader } from './components/Fader.tsx';
import { HeldChip } from './components/HeldChip.tsx';
import { LockBar } from './components/setup/LockBar.tsx';
import { useLocked } from './lockStore.ts';
import { useRemote } from './remoteStore.ts';
import { openLibrarySheet } from './libraryStore.ts';
import './styles/remote.css';

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
  const viewPref = useStore((s) => s.view);
  // The two layout states this file owns beside the window itself.
  //
  // `remote` is design 2.11: touch on and a window under 900px — the phone,
  // never the 1024 tablet, which is Pads at touch density. `locked` is the
  // client's own lock (lockStore), on by default on glass and on anything that
  // is not the engine's own host. Both resolve to the SAME Pads view over the
  // same components; neither is a fork.
  const remote = useRemote((s) => s.remote);
  const locked = useLocked();
  const latched = useRemote((s) => s.latch);
  // The same wash says the same thing for learn mode: this grid is not firing
  // cues right now, it is taking bindings (design #32).
  const learnMode = useStore((s) => s.learnMode);
  // Locked is the pads and nothing else, and the remote IS the pads — so the
  // saved view is remembered but not obeyed until the lock comes off. Every
  // performing control keeps working; what goes is the Rig page and the panels.
  const view: ViewMode = remote || locked ? 'pads' : viewPref;
  const previzHidden = useStore((s) => s.previzHidden);
  const togglePreviz = useStore((s) => s.togglePreviz);
  const libraryHiddenPref = useStore((s) => s.libraryHidden);
  const touch = useStore((s) => s.touch);
  const helpMode = useStore((s) => s.helpMode);
  const setLibraryHidden = useStore((s) => s.setLibraryHidden);
  const editorHiddenPref = useStore((s) => s.editorHidden);
  const setEditorHidden = useStore((s) => s.setEditorHidden);
  // The engine serves this same UI to a phone on the floor, and the desktop
  // window is anything from the Tauri floor up. Track both dimensions and let
  // the pads win (design 2.2): a side panel opens only beside all eight
  // columns, and vertically the band gives way before the grid does — a
  // panel or a band that has no room folds to its strip whatever the saved
  // preference says.
  const [win, setWin] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // The chrome above the band is measured, not assumed: until #24 gives the
  // top bar a drop order it wraps to a second row on a narrow window, and a
  // band sized against the token alone would push the grid under the fold.
  // What is measured is the band's top edge — the top bar, an engine-loss bar
  // and the seams between them — re-read whenever any of those changes size.
  const [chromeH, setChromeH] = useState<number>(size.topbar + APP_GAP);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    // `.topbar` has not existed since the bar became a command strip and a
    // status line; the fallback sum was measuring one element short, so a
    // window with no band sized its grid against too little chrome.
    const els = [...document.querySelectorAll('.offlinebar, .commandstrip, .statusline')];
    if (els.length === 0) return;
    const measure = () => {
      const band = document.querySelector('.previz, .previzstrip');
      setChromeH(
        band
          ? band.getBoundingClientRect().top
          : els.reduce((n, el) => n + el.getBoundingClientRect().height + APP_GAP, 0),
      );
    };
    const ro = new ResizeObserver(measure);
    for (const el of els) ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [hasProject, connected, engineStalled]);
  const stripW = touch ? sizeTouch.strip : size.strip;
  const floors = panelFloors(stripW);
  // A locked client has no side panels and no reveal strips: they open the
  // library and the editor, and locked those are reached through the tray —
  // or not at all. The remote is below both floors anyway.
  const libraryFits = !locked && win.w >= floors.library;
  const editorFits = !locked && win.w >= floors.editor;
  const roomForBoth = win.w >= floors.both;
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
  /** reveal strips on screen: a folded panel leaves one only where it could open */
  const strips = (libraryHidden && libraryFits ? 1 : 0) + (editorHidden && editorFits ? 1 : 0);
  const [layout, setLayout] = useState(loadLayout);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStalled(true), 8000);
    return () => clearTimeout(t);
  }, []);
  // Asked once, over the Tauri bridge rather than the socket, so it answers
  // even though no engine is listening. A browser or the LAN tablet has no
  // bridge and never sees a gate — they are not the machine running the show.
  const [shortcuts, setShortcuts] = useState(false);
  // Read once at mount: the card is a first-launch thing, and re-reading it
  // per render would make dismissing it a re-render race with itself.
  const [welcome, setWelcome] = useState(() => !welcomeSeen());
  const [gate, setGate] = useState<LicenceStatus | null>(null);
  useEffect(() => {
    if (!licenceAvailable()) return;
    licenceStatus().then(setGate).catch(() => setGate(null));
  }, []);
  // Two things that had no presence outside the settings modal: a trial about
  // to end, and an update waiting (review M5). The top bar shows a chip and a
  // dot; both are shell-only, so a browser or the tablet never asks.
  const [updateWaiting, setUpdateWaiting] = useState(false);
  useEffect(() => {
    if (!updateAvailable()) return;
    let stop = false;
    const look = () => updateStatus().then((s) => { if (!stop) setUpdateWaiting(!!s.available); }).catch(() => {});
    const first = setTimeout(look, 15_000); // the shell's own check runs at startup; give it a moment
    const every = setInterval(look, 30 * 60_000);
    return () => { stop = true; clearTimeout(first); clearInterval(every); };
  }, []);
  const trialDaysLeft =
    gate?.claims && gate.claims.edition.toLowerCase() === 'trial'
      ? Math.max(0, Math.ceil((gate.claims.exp - Date.now() / 1000) / 86_400))
      : null;
  // The previz rides across the top of every view (rigs are wider than tall);
  // each view remembers its own hide state, and the full-screen previz view is
  // never hidden — it IS the previz. In the pads view the window has the last
  // word: when even a folded groups row and 58px pads cannot fit under the
  // band's floor, the band folds to its strip (the last step of 2.2's order).
  const stripH = touch ? sizeTouch.strip : size.strip;
  const bandView: BandView | null = view === 'previz' ? null : view;
  // `bandView === null` IS the full-screen Stage, which is nothing but the
  // band — so it is always shown. Reading that as "no view, so no band" left
  // the Stage view rendering a reveal strip into a grid area its template does
  // not define, and the whole screen blank.
  const bandPref = bandView === null || !previzHidden[bandView];
  const fit = view === 'pads' ? padsFit(win.h, chromeH, stripH, bandPref) : null;
  // On the remote the band is not folded, it is absent: 390px of glass holds
  // the strip, the pads and the levels, and a stage view on it would be a
  // picture of the room you are standing in (design 2.11).
  const bandHidden = remote || !bandPref || (fit?.bandFolds ?? false);
  /** Pads and Build keep separate band heights: Pads opens at a fraction of
   *  the window, Build at the audition's own height (design 2.8). */
  const bandKey: keyof Layout = view === 'split' ? 'buildH' : 'bandH';
  const clampOpts = { view, bandHidden, panels: sidePanels, strips, stripW, win, chromeH, fit };
  const resize = (key: keyof Layout, delta: number) =>
    setLayout((l) => {
      // `keep` is the track under the operator's cursor: it wins, and the other
      // vertical track gives way. Without it a drag would fight itself.
      const next = clampLayout({ ...l, [key]: l[key] + delta }, { ...clampOpts, keep: key });
      try { localStorage.setItem('layout', JSON.stringify(next)); } catch { /* non-essential */ }
      return next;
    });
  // A band sized in the pads view can be too tall for the split view, which
  // stacks an editor under the same grid — re-clamp on arrival rather than
  // rendering a squeezed pad row. Collapsing the band re-clamps too: the editor
  // may now stretch into the room the band was holding. A window resize, or
  // the top bar wrapping to a second row, re-clamps the same way.
  const wasHidden = useRef(bandHidden);
  useEffect(() => {
    // Revealing the band is the editor giving back what it took while the band
    // was away, so the band's remembered height wins that one exchange. Every
    // other re-clamp splits the shortfall proportionally.
    const revealing = wasHidden.current && !bandHidden;
    wasHidden.current = bandHidden;
    setLayout((l) => clampLayout(l, { ...clampOpts, ...(revealing ? { keep: bandKey } : {}) }));
  }, [view, bandHidden, libraryHidden, editorHidden, win.w, win.h, chromeH, touch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      // A fader keeps focus after a click so its arrows work (design 2.6), and
      // it stops the keys it owns from getting this far by itself. Stepping
      // aside for every `[role=slider]` instead would take BLACKOUT, TAP, the
      // song keys and Esc away for as long as a master held focus — the panic
      // keys must never depend on what was clicked last.
      if (t?.isContentEditable) return;
      // ? opens the sheet that lists everything below it. Shift-slash on most
      // layouts, and no binding wants a bare "?" — so it is checked here
      // rather than earning a row in a table it exists to display.
      if (e.key === '?') {
        e.preventDefault();
        setShortcuts((v) => !v);
        return;
      }
      runShortcut(e, useStore.getState());
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
          <div className="prose" style={{ maxWidth: 380, textAlign: 'center' }}>
            The engine is not responding. Another copy of LIGHT (or other software) may be holding
            port {WS_PORT} — quit it and reopen, or check Console.app for “[light]” errors.
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      // `previz-off` is the band's reveal strip, which the remote does not
      // have — its own template has no track for one, and carrying the class
      // would only hand theme.css a template of the same weight as this one.
      className={`app view-${view} ${bandHidden && !remote ? 'previz-off' : ''} ${touch ? 'touch' : ''} ${remote ? 'remote' : ''} ${locked ? 'locked' : ''} ${helpMode ? 'helpmode' : ''} ${fit?.groupsFolded ? 'groups-folded' : ''} ${fit?.padsShort ? 'pads-short' : ''}`}
      style={{
        ['--previz-h' as string]: `${layout[bandKey]}px`,
        ['--bottom-h' as string]: `${layout.bottomH}px`,
        // A collapsed side panel is a reveal strip (--strip: 18px, 24px in touch
        // mode) in the same grid column, and its splitter track goes to zero —
        // one pads template covers every combination instead of a class per
        // permutation. A panel the window cannot hold beside eight columns
        // leaves no strip at all: its track is empty and zero wide.
        ['--library-w' as string]: !libraryHidden ? `${layout.libraryW}px` : libraryFits ? 'var(--strip)' : '0px',
        ['--lsplit-w' as string]: libraryHidden ? '0px' : 'var(--size-splitter)',
        ['--editor-w' as string]: !editorHidden ? `${layout.editorW}px` : editorFits ? 'var(--strip)' : '0px',
        ['--esplit-w' as string]: editorHidden ? '0px' : 'var(--size-splitter)',
      }}
    >
      {(!connected || engineStalled) && (
        <div className="offlinebar">
          {connected
            ? 'ENGINE STALLED — connected, but the show engine has stopped responding'
            : 'ENGINE OFFLINE — reconnecting… nothing you press is reaching the rig'}
        </div>
      )}
      {/* The fixed strip (design 2.11). On the remote the command strip keeps
          its panic track and gives up everything else — the view keys, the
          tempo block, the show's name: a locked phone steers by none of them —
          and the master and the lamp ride beside the pair at
          --size-panic-h-touch. The top bar itself is unchanged, because the
          two keys in that track are two of the five gestures that reach the
          rig and they may not be re-implemented anywhere. */}
      {remote ? (
        <div className="remotetop">
          <Region name="top bar"><TopBar onOpenAdmin={() => openSetup()} updateWaiting={updateWaiting} trialDaysLeft={trialDaysLeft} /></Region>
          <RemoteMaster />
        </div>
      ) : (
        <Region name="top bar"><TopBar onOpenAdmin={() => openSetup()} updateWaiting={updateWaiting} trialDaysLeft={trialDaysLeft} /></Region>
      )}
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
      {/* The band's reveal strip — never on the remote, which has no band to
          reveal and no grid track to put a strip in: rendered there it takes a
          column of its own and 50px off the pads. */}
      {bandHidden && !remote && (
        <div
          className="previzstrip"
          role="button"
          tabIndex={0}
          title={
            fit?.bandFolds
              ? 'the stage needs a taller window than this — the pads keep the height here'
              : 'show the stage (hidden in this view only)'
          }
          onClick={() => { if (bandView && !fit?.bandFolds) togglePreviz(bandView); }}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && bandView && !fit?.bandFolds) { e.preventDefault(); togglePreviz(bandView); } }}
        >
          <span className="label">stage <Glyph name="chevron" /></span>
        </div>
      )}
      {view !== 'previz' && !bandHidden && (
        <Splitter dir="h" area="psplit" onDrag={(d) => resize(bandKey, d)} />
      )}
      {(view === 'split' || view === 'pads') && (
        // The latch takes the same cyan wash MIDI learn does, because it is the
        // same arm shape: the grid is a surface you are pointing at, not one
        // you are playing (design 2.11).
        <div className={`gridwrap ${latched || learnMode ? 'learn' : ''}`}>
          <Region name="look grid"><LookGrid /></Region>
        </div>
      )}
      {/* The levels tier and the bottom bar are auto-placed rows under the
          grid: no template names them, so they sit below whatever template the
          view is using rather than making the remote a second set of them. */}
      {remote && <Region name="levels"><RemoteLevels /></Region>}
      {/* On glass the bar stays after the unlock: the tray is how a tablet
          reaches the library and the editor (design 2.11), and the lock key is
          how it goes back to being locked. A desk client sees it only while it
          is locked — unlocked, it has the setup surface and the panels. */}
      {(touch || locked) && (
        <Region name="lock bar"><BottomBar locked={locked} /></Region>
      )}
      {view === 'pads' && !libraryHidden && (
        <Splitter dir="v" area="lsplit" onDrag={(d) => resize('libraryW', -d)} />
      )}
      {view === 'pads' && !libraryHidden && (
        <div className="library panel">
          <Region name="look library"><LookLibrary /></Region>
        </div>
      )}
      {/* A folded panel leaves its reveal strip only where it could open: on a
          window below the panel's floor the grid keeps every pixel (2.2), and
          the library is reached by the sheet (#29) instead. */}
      {view === 'pads' && libraryHidden && libraryFits && (
        <div
          className="librarystrip"
          title="show the look library"
          role="button"
          tabIndex={0}
          onClick={revealLibrary}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealLibrary(); } }}
        >
          <span className="label">looks <Glyph name="chevron" /></span>
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
      {view === 'pads' && editorHidden && editorFits && (
        <div
          className="editorstrip"
          title="show the look editor"
          role="button"
          tabIndex={0}
          onClick={revealEditor}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealEditor(); } }}
        >
          <span className="label">editor <Glyph name="chevron" /></span>
        </div>
      )}
      {/* No splitter under Build's context row: the row is a fixed
          --size-gridstrip (tabs + heads + one pad row) and the editor takes
          what is left, so there is nothing to trade between them. The band's
          own splitter above still trades the audition against the editor. */}
      {(view === 'split' || view === 'patch') && (
        <div className="bottom panel">
          <Region name="bottom panel"><BottomPanel /></Region>
        </div>
      )}
      <Toasts />
      <SetupGuide />
      {shortcuts && <ShortcutSheet onClose={() => setShortcuts(false)} />}
      {/* After the licence gate by construction: that returns early above. */}
      {welcome && !locked && <WelcomeCard onClose={() => setWelcome(false)} />}
      <HelpOverlay />
      {/* One sheet for output, sync, display, lock, licence and updates —
          always mounted, drawing nothing until something opens it, because the
          layout menu can load a controller preset without opening it and the
          undo chip for that has to outlive the sheet.

          Locked, it is not mounted at all: "no sheets but help, levels and the
          song picker" (design 2.11). Nothing is stranded by that — the lock bar
          is on screen the whole time a client is locked, and the hold on its
          key is what brings the setup surface back. */}
      {!locked && <SetupSheet onOpenShortcuts={() => setShortcuts(true)} />}
      {/* The library laid over the grid, for every window too narrow to hold a
          column beside eight pads, and for glass. The Find field is the one
          way to ask the show a question — and only a song hit moves a light.
          Both are sheets, so both wait for the unlock. */}
      {!locked && <LibrarySheet />}
      {!locked && <Find />}
      <DialogHost />
    </div>
  );
}

/** The master and the lamp, beside the panic pair on the remote's fixed strip
 *  (design 2.11). The master is the same Fader every other master on the desk
 *  is; the lamp is a readout and nothing more — going live is a setup action,
 *  and a locked phone at front of house is not where it is taken. */
function RemoteMaster() {
  const master = useStore((s) => s.snap?.master);
  const live = useStore((s) => s.snap?.transmit) === true;
  const connected = useStore((s) => s.connected);
  const engineStalled = useStore((s) => s.engineStalled);
  const send = useStore((s) => s.send);
  const lost = !connected || engineStalled;
  return (
    <div className="remotemaster">
      <Fader
        label="master"
        help="grand master — scales everything the show puts out. Double-tap for full"
        value={master ?? 1}
        onChange={(v) => send({ type: 'setMaster', v })}
        def={1}
        learn={{ kind: 'grand' }}
        variant="dim"
        width="100%"
      />
      <div
        className={`remotelamp ${lost ? 'lost' : live ? 'live' : ''}`}
        title={
          lost
            ? 'the engine is not answering — nothing you press here is reaching the rig'
            : live
              ? 'the rig is receiving what this screen is playing'
              : 'nothing is reaching the rig. The show is running; the output gate is shut'
        }
      >
        <i className="lamp" aria-hidden="true" />
        <span className="label">{lost ? 'no engine' : live ? 'live' : 'offline'}</span>
      </div>
    </div>
  );
}

/** The levels tier (design 2.11): the layer masters, speed, haze and tap on one
 *  row near the bottom, where a thumb is. It scrolls sideways when the rig has
 *  more layers than the glass has room for — a level is a thing you reach for,
 *  not a thing you read, and nothing here is a pad. */
function RemoteLevels() {
  const layers = useStore((s) => s.project?.layers);
  const speed = useStore((s) => s.snap?.speed);
  const haze = useStore((s) => s.snap?.haze);
  const frozen = useStore((s) => s.snap?.frozen) === true;
  const send = useStore((s) => s.send);
  // top of the stack first, the way the grid stacks them
  const order = [...(layers ?? [])].reverse();
  return (
    <div className="remotelevels">
      {order.map((l) => (
        <Fader
          key={l.id}
          label={headName(l.name)}
          help={`${l.name} master — scales everything this layer puts out. Double-tap for full`}
          value={l.master}
          onChange={(v) => send({ type: 'setLayerMaster', layerId: l.id, v })}
          def={1}
          variant="dim"
          learn={{ kind: 'layerMaster', layerId: l.id }}
        />
      ))}
      <Fader
        label="speed"
        help="how fast every effect in the show runs, against the tempo"
        min={-2}
        max={2}
        def={0}
        value={Math.log2(speed ?? 1)}
        fmt={(v) => `${Math.pow(2, v).toFixed(2)}×`}
        onChange={(v) => send({ type: 'setSpeed', v: Math.pow(2, v) })}
        learn={{ kind: 'speed' }}
        variant="dim"
      />
      <Fader
        label="haze"
        help="how much haze the machine puts out — the beams are only as visible as the air"
        value={haze ?? 0}
        onChange={(v) => send({ type: 'setHaze', v })}
        def={0}
        learn={{ kind: 'haze' }}
        variant="dim"
      />
      <button
        className="btn tapkey"
        title="tap the beat — four taps sets the tempo, and every tap also lands the downbeat"
        onClick={() => {
          if (!useStore.getState().armLearn({ kind: 'tap' })) send({ type: 'tap' });
        }}
      >
        tap
      </button>
      {/* Freeze rides here because the lock promises it: locked is the pads and
          nothing else, and pads, columns, songs, dials, groups, masters,
          blackout, all stop and freeze all keep working. The strip it normally
          sits on is not on this screen, so the key moves rather than the
          promise. Same command, same words as the desk's own. */}
      <button
        className={`btn ${frozen ? 'warn on' : 'ghost'}`}
        title={
          frozen
            ? 'HELD — the rig is repeating the frame it was on, and the show is still running underneath. Tap to let it through.'
            : 'hold the rig on the frame it is showing, set up the next column, then release'
        }
        onClick={() => send({ type: 'setFreeze', v: !frozen })}
      >
        {frozen ? 'held' : 'freeze'}
      </button>
    </div>
  );
}

/** The bottom bar: the lock line, and beside it the tray, the edit latch and
 *  the help key (design 2.11).
 *
 *  It is on screen whenever a client is locked, remote or not — a laptop on the
 *  network locks itself by default too, and the hold on this key is the only
 *  way back to the Rig page and the setup surface. */
function BottomBar({ locked }: { locked: boolean }) {
  const [tray, setTray] = useState(false);
  const [editor, setEditor] = useState(false);
  const helpMode = useStore((s) => s.helpMode);
  const setHelpMode = useStore((s) => s.setHelpMode);
  const latched = useRemote((s) => s.latch);
  const toggleLatch = useRemote((s) => s.toggleLatch);
  // A lock closes the tray with it: everything in the tray is a sheet, and
  // locked there are no sheets but help, the levels and the song picker.
  useEffect(() => {
    if (!locked) return;
    setTray(false);
    setEditor(false);
  }, [locked]);
  return (
    <>
      <div className="bottombar">
        <LockBar />
        <div className="bottomkeys">
          {!locked && (
            <button
              className={`btn tray ${tray ? 'on' : ''}`}
              aria-expanded={tray}
              title="the tray — the looks, what is held, the look editor and the setup surface"
              onClick={() => setTray((o) => !o)}
            >
              tray <Glyph name="tray" />
            </button>
          )}
          {!locked && (
            <button
              className={`btn latchkey ${latched ? 'on' : ''}`}
              aria-pressed={latched}
              title={
                latched
                  ? 'the grid is latched for editing: a tap selects a pad, a hold opens its menu, and nothing fires. Tap to let it play again (keyboard: E)'
                  : 'latch the grid for editing — while it is on, a tap selects a pad instead of firing it (keyboard: E)'
              }
              onClick={() => toggleLatch()}
            >
              edit {latched ? '●' : '○'}
            </button>
          )}
          <button
            className={`btn help ${helpMode ? 'on' : ''}`}
            aria-pressed={helpMode}
            title="help — tap anything to find out what it does"
            onClick={() => setHelpMode(!helpMode)}
          >
            ?
          </button>
        </div>
        {tray && !locked && (
          <div className="traysheet panel">
            <button
              className="btn small ghost"
              title="the look library — tap a look to arm it, then a pad’s name to put it there"
              onClick={() => { setTray(false); openLibrarySheet(); }}
            >
              looks
            </button>
            <button
              className="btn small ghost"
              title="the look editor, over the whole screen — what the selected pad is playing, and every part of it"
              onClick={() => { setTray(false); setEditor(true); }}
            >
              look editor
            </button>
            <button
              className="btn small ghost"
              title="output, sync, display, the lock and the licence"
              onClick={() => { setTray(false); openSetup(); }}
            >
              setup
            </button>
            {/* What is standing between the show and the room, with the verb
                that ends it. It draws nothing at all when nothing is held. */}
            <HeldChip />
          </div>
        )}
      </div>
      {editor && !locked && (
        <div className="editorsheet panel">
          <div className="sheetbar">
            <span className="label">look editor</span>
            <button className="btn small ghost" title="close the look editor" onClick={() => setEditor(false)}>
              <Glyph name="clear" alone />
            </button>
          </div>
          <Region name="look editor"><EditorPane /></Region>
        </div>
      )}
    </>
  );
}

type Layout = { bandH: number; buildH: number; bottomH: number; libraryW: number; editorW: number };

/** Floors, and the fixed furniture around the adjustable tracks — every one a
 *  design token (tokens.ts, generated from Figma), the same numbers theme.css
 *  lays the grid out with. Vertically the pads view keeps MIN_GRID_H under the
 *  band and the split view keeps one pad row; horizontally a pads-view side
 *  panel opens only beside all eight columns (design 2.2). */
/** heads + song row + five 72px rows + groups + gaps + wrapper padding */
const MIN_GRID_H = size['min-grid-h'];
/** the split view's grid until #42: one pad row, the editor takes the rest */
const MIN_GRID_SPLIT = size.gridstrip;
const MIN_BAND = size['min-band'];
const MIN_PANEL = size['min-panel'];
/** the eight-column grid with the narrow (96px) head — what sits beside an open panel */
const MIN_GRID_W_NARROW = size['min-grid-w-narrow'];
const MIN_LIBRARY = size['min-library'];
const MIN_EDITOR = size['min-editor'];
/** .gridwrap pads --space-10 on every side */
const WRAP_PAD = 2 * space['10'];
/** the seam between two of the app grid's tracks (.app { gap }) */
const APP_GAP = space['1'];
/** the pads view's five column tracks are always laid, so four seams sit in
 *  its width whether or not a panel is open; below the band, the splitter (or
 *  the band's strip) and the grid add two (or one) more */
const PADS_SEAMS_W = 4 * APP_GAP;
/** the groups row and its gap — what folding it gives back. Not a token yet:
 *  design 2.2 counts the row as 40 and names no size/groups-h. */
const GROUPS_ROW_GIVE = 40 + space['3'];
/** four layer rows and the dials row, each from 72 to 58 — what shortening the pads gives back */
const PAD_H_GIVE = (APC_LAYER_ROWS + 1) * (size['pad-h-pads'] - size['pad-h']);
/** the split view's splitter tracks under the chrome */
const SPLIT_TRACKS = 3 * size.splitter;
/** Window widths below which a pads-view side panel cannot open at all: the
 *  narrow-head grid, the wrapper padding, the panel's floor, its splitter and
 *  one reveal strip (design 2.2: 1,165 / 1,265; both together 1,453, which no
 *  1440 window holds). The strip is wider in touch mode. */
const panelFloors = (stripW: number) => ({
  library: MIN_GRID_W_NARROW + WRAP_PAD + PADS_SEAMS_W + MIN_LIBRARY + size.splitter + stripW,
  editor: MIN_GRID_W_NARROW + WRAP_PAD + PADS_SEAMS_W + MIN_EDITOR + size.splitter + stripW,
  both: MIN_GRID_W_NARROW + WRAP_PAD + PADS_SEAMS_W + MIN_LIBRARY + MIN_EDITOR + 2 * size.splitter,
});

type Fit = {
  /** the groups row is folded away */
  groupsFolded: boolean;
  /** pads at 58 rather than 72 */
  padsShort: boolean;
  /** the band is folded to its strip by the window, not by choice */
  bandFolds: boolean;
  /** the tallest the band may be */
  bandMax: number;
};

/** Design 2.2's order of giving way in the pads view: the band shrinks to its
 *  floor, then the groups row folds, then the pads shorten to 58, and last the
 *  band folds to its strip. `bandShown` is the preference; the window may
 *  still fold it. Once anything has folded the band sits at its floor, so the
 *  grid gets what the fold bought. */
const padsFit = (innerH: number, chromeH: number, stripH: number, bandShown: boolean): Fit => {
  const stages = (room: number) => {
    let need = MIN_GRID_H;
    let groupsFolded = false;
    let padsShort = false;
    if (room < need) { groupsFolded = true; need -= GROUPS_ROW_GIVE; }
    if (room < need) { padsShort = true; need -= PAD_H_GIVE; }
    return { groupsFolded, padsShort, fits: room >= need, need };
  };
  if (bandShown) {
    const room = innerH - chromeH - size.splitter - 2 * APP_GAP;
    const s = stages(room - MIN_BAND);
    if (s.fits) {
      return {
        groupsFolded: s.groupsFolded,
        padsShort: s.padsShort,
        bandFolds: false,
        bandMax: s.groupsFolded ? MIN_BAND : Math.max(MIN_BAND, room - s.need),
      };
    }
  }
  const s = stages(innerH - chromeH - stripH - APP_GAP);
  return { groupsFolded: s.groupsFolded, padsShort: s.padsShort, bandFolds: bandShown, bandMax: MIN_BAND };
};

/** Take `over` px off the tracks in `order`, each down to its floor, stopping
 *  when the debt is paid. The track under the operator's cursor is asked LAST,
 *  so a drag keeps following the pointer while anything else can still give;
 *  when everything is floored the loop simply runs out and the drag stops,
 *  rather than the grid between them paying for it. */
const absorb = (
  out: Layout,
  order: (keyof Layout)[],
  floors: Partial<Record<keyof Layout, number>>,
  over: number,
): void => {
  for (const key of order) {
    if (over <= 0) break;
    const give = Math.min(over, out[key] - (floors[key] ?? 0));
    out[key] -= give;
    over -= give;
  }
};

/** Fit the saved sizes to the window.
 *
 *  `view` matters because the two axes are only constrained where the panels
 *  actually stack: vertically in the split view (band + pads + editor) and the
 *  pads view (band + the whole grid), and horizontally in the pads view (grid
 *  + library + look editor). Clamping each track on its own lets their SUM eat
 *  the grid between them and push the last panel off a viewport with no
 *  scrollbar to get it back. `keep` names the track being dragged — the one
 *  that wins. `panels` lists the pads-view side panels currently on screen and
 *  `strips` the reveal strips beside them; a folded panel costs its strip, not
 *  its width, and only where it could open. `fit` is the pads view's vertical
 *  verdict from padsFit. */
const clampLayout = (
  l: Layout,
  opts: {
    view?: ViewMode;
    keep?: keyof Layout;
    bandHidden?: boolean;
    panels?: (keyof Layout)[];
    strips?: number;
    stripW?: number;
    win?: { w: number; h: number };
    chromeH?: number;
    fit?: Fit | null;
  } = {},
): Layout => {
  const w = opts.win?.w ?? window.innerWidth;
  const h = opts.win?.h ?? window.innerHeight;
  const chromeH = opts.chromeH ?? size.topbar + APP_GAP;
  const out: Layout = {
    // a band must leave working room below it, whatever the window size
    bandH: Math.min(Math.max(l.bandH, MIN_BAND), Math.max(MIN_BAND, h - chromeH - size.splitter - MIN_PANEL)),
    buildH: Math.min(Math.max(l.buildH, MIN_BAND), Math.max(MIN_BAND, h - chromeH - size.splitter - MIN_PANEL)),
    bottomH: Math.max(l.bottomH, MIN_PANEL),
    libraryW: Math.max(l.libraryW, MIN_LIBRARY),
    editorW: Math.max(l.editorW, MIN_EDITOR),
  };

  if (opts.view === 'pads' && opts.fit && !opts.bandHidden) {
    out.bandH = Math.min(out.bandH, opts.fit.bandMax);
  }

  if (opts.view === 'split' && opts.bandHidden) {
    // A collapsed band costs its reveal strip, not its remembered height. Reserving
    // that height anyway would dead-end the editor drag well short of the room
    // on screen — and worse, draining the band to pay for it would destroy the
    // band size the operator set, which they only see when it comes back.
    const stripH = useStore.getState().touch ? sizeTouch.strip : size.strip;
    const room = h - chromeH - stripH - size.splitter - MIN_GRID_SPLIT;
    out.bottomH = Math.min(out.bottomH, Math.max(MIN_PANEL, room));
  } else if (opts.view === 'split') {
    const room = h - chromeH - SPLIT_TRACKS - MIN_GRID_SPLIT;
    let over = out.buildH + out.bottomH - room;
    if (over > 0) {
      if (!opts.keep) {
        // No drag in progress (window resize, view switch): take it off both in
        // proportion first, so neither panel collapses because the window
        // shrank. Flooring can leave a remainder — absorb() finishes it.
        const k = Math.max(0, room) / (out.buildH + out.bottomH);
        out.buildH = Math.max(MIN_BAND, Math.floor(out.buildH * k));
        out.bottomH = Math.max(MIN_PANEL, Math.floor(out.bottomH * k));
        over = out.buildH + out.bottomH - room;
      }
      absorb(
        out,
        opts.keep === 'buildH' ? ['bottomH', 'buildH'] : ['buildH', 'bottomH'],
        { buildH: MIN_BAND, bottomH: MIN_PANEL },
        over,
      );
    }
  }

  if (opts.view === 'pads') {
    // Same reasoning, sideways: the library and the look editor share what is
    // left of the width after the grid keeps its eight columns with the narrow
    // head, the wrapper padding, each open panel's splitter and each strip.
    const panels = opts.panels ?? [];
    const shown = panels.filter((p) => p === 'libraryW' || p === 'editorW');
    if (shown.length > 0) {
      const stripW = opts.stripW ?? size.strip;
      const room = w - MIN_GRID_W_NARROW - WRAP_PAD - PADS_SEAMS_W - shown.length * size.splitter - (opts.strips ?? 0) * stripW;
      const total = shown.reduce((n, k) => n + out[k], 0);
      const over = total - room;
      if (over > 0) {
        const order = shown.length === 2
          ? (opts.keep === 'libraryW' ? ['editorW', 'libraryW'] : ['libraryW', 'editorW'])
          : shown;
        absorb(out, order as (keyof Layout)[], { libraryW: MIN_LIBRARY, editorW: MIN_EDITOR }, over);
      }
    }
  }
  // On a window below the sum of the floors nothing usable fits either way, and
  // the floors keep every panel operable rather than collapsing one to nothing.
  return out;
};

function loadLayout(): Layout {
  // Field-by-field: a layout saved before the band split into a Pads height
  // and a Build height has previzH only — keep what still applies, default the
  // rest. The two band heights open as the design says (store.ts PADS_OPENS,
  // BUILD_OPENS): a fraction of the window in Pads, the audition alone in Build.
  let saved: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem('layout') ?? 'null');
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch { /* defaults below */ }
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return clampLayout({
    bandH: num(saved.bandH, Math.round(window.innerHeight * PADS_OPENS.bandRatio)),
    buildH: num(saved.buildH, BUILD_OPENS.bandH),
    bottomH: num(saved.bottomH, size['bottom-h']),
    libraryW: num(saved.libraryW, size['library-w']),
    editorW: num(saved.editorW, size['editor-w']),
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
