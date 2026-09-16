import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, type ViewMode } from '../store.ts';
import { askConfirm, askPrompt } from '../dialog.tsx';
import { Fader } from './Fader.tsx';
import { HeldChip } from './HeldChip.tsx';
import { TintKey } from './TintKey.tsx';
import { BAR, clamp } from '../../../shared/types.ts';
import { motion, size } from '../tokens.ts';
import { openSetup } from './AdminModal.tsx';
import { Glyph } from '../glyphs.tsx';

function StatusDot({ ok, label, warn, bad, traffic, title }: {
  ok: boolean; label: string; warn?: boolean; bad?: boolean; traffic?: boolean; title?: string;
}) {
  return (
    <div className="dotline" title={title ?? label}>
      <div className={`statusdot ${bad ? 'bad' : ok ? 'ok' : warn ? 'warn' : ''} ${traffic ? 'traffic' : ''}`} />
      <span className="label">{label}</span>
    </div>
  );
}

function ProjectMenu({ name, short }: { name: string; short: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const send = useStore((s) => s.send);
  const projects = useStore((s) => s.projects);
  const snap = useStore((s) => s.snap);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    send({ type: 'projects' }); // refresh the list every time the menu opens
    const close = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open, send]);

  // Anything currently on stage — so opening another show can warn that it goes
  // dark, rather than doing it on a stray tap.
  const anyLive = (snap?.layers ?? []).some((l) => !!l.lookId);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 2, left: r.left });
    setOpen((o) => !o);
  };

  const openProject = (slug: string, projName: string) => {
    setOpen(false);
    if (slug === projects?.current) return;
    void (async () => {
      if (anyLive) {
        const ok = await askConfirm(`Open "${projName}"?`, {
          body: 'The current show stops and the stage goes dark. You can reopen this one afterwards, but every layer will need re-firing.',
          confirmLabel: 'Open project',
          danger: true,
        });
        if (!ok) return;
      }
      send({ type: 'openProject', slug });
    })();
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        className="btn small ghost projname"
        // Narrow, the name gives way to its own caret rather than pushing the
        // panic pair off the strip — the show's name is not what you steer by.
        title={short ? `${name} — projects` : 'projects'}
        onClick={openMenu}
      >
        {short ? <Glyph name="chevron" alone /> : <>{name} <Glyph name="chevron" /></>}
      </button>
      {open && (
        <div className="popover" style={{ top: pos.top, left: pos.left }}>
          {(projects?.list ?? []).map((p) => (
            <button
              key={p.slug}
              className={`btn small ghost ${p.slug === projects?.current ? 'on' : ''}`}
              title={`open “${p.name}” — the running show is saved first, and undo history does not cross projects`}
              onClick={() => openProject(p.slug, p.name)}
            >
              {p.slug === projects?.current ? <Glyph name="tick" /> : null}{p.name}
            </button>
          ))}
          <div className="popover-rule" />
          <button
            className="btn small ghost"
            style={{ justifyContent: 'flex-start' }}
            title="start an empty show — a blank grid and no fixtures. The current show is saved first."
            onClick={() => {
              setOpen(false);
              void (async () => {
                if (anyLive) {
                  const ok = await askConfirm('Start a new project?', {
                    body: 'The current show stops and the stage goes dark. It is saved first and stays in this menu.',
                    confirmLabel: 'New project',
                    danger: true,
                  });
                  if (!ok) return;
                }
                const n = await askPrompt('New project', '', { placeholder: 'project name' });
                if (n) send({ type: 'newProject', name: n });
              })();
            }}
          >
            + new project…
          </button>
          <button
            className="btn small ghost"
            style={{ justifyContent: 'flex-start' }}
            title="save a copy under a new name and switch to it — the show you are on is left as it was"
            onClick={() => {
              setOpen(false);
              void (async () => {
                const n = await askPrompt('Save project as', name, { confirmLabel: 'Save' });
                if (!n) return;
                const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
                const clash = projects?.list.find((p) => p.slug === slug && p.slug !== projects.current);
                if (clash) {
                  const ok = await askConfirm(`Overwrite "${clash.name}"?`, {
                    body: 'A project with that name already exists. The old file is kept aside as a .replaced backup.',
                    confirmLabel: 'Overwrite',
                    danger: true,
                  });
                  if (!ok) return;
                }
                send({ type: 'saveProjectAs', name: n });
              })();
            }}
          >
            save as…
          </button>
        </div>
      )}
    </div>
  );
}

/** The four layouts, in the order they sit on the bar. Alt-1..4 matches the
 *  position, so the shortcut is readable off the screen. */
const VIEWS: { id: ViewMode; label: string; title: string; key: string }[] = [
  { id: 'pads', label: 'Pads', title: 'Perform — the stage over the pads, look library at the right', key: '1' },
  { id: 'previz', label: 'Stage', title: 'Stage — the 3D stage, full screen', key: '2' },
  { id: 'patch', label: 'Rig', title: 'Rig — the 2D plan over the fixtures: drag them into place', key: '3' },
  { id: 'split', label: 'Build', title: 'Build — the stage over the pads and the look editor', key: '4' },
];

/** What gives way, and in what order, when the strip runs out of room.
 *
 *  A `move` sends the control down to the status line, where it still works; a
 *  `shrink` leaves it on the strip in a smaller form. The order is the design's
 *  (2.1): the two faders nobody reaches for mid-song go first, then SYNC (the
 *  key has a shortcut and the tap is beside it), then the show's name, then the
 *  master narrows, and FREEZE is the last thing to leave. Nothing that stops
 *  the rig is on this list — the panic pair has a track of its own. */
const DROP_STEPS: { id: string; kind: 'move' | 'shrink' }[] = [
  { id: 'speed', kind: 'move' },
  { id: 'haze', kind: 'move' },
  { id: 'sync', kind: 'move' },
  { id: 'project', kind: 'shrink' },
  { id: 'master', kind: 'shrink' },
  { id: 'freeze', kind: 'move' },
  // Last of all the wordmark, which performs nothing: below the tablet the
  // remote layout takes over anyway, and a narrow window that still has to
  // show the strip would rather spend those pixels on the tempo.
  { id: 'wordmark', kind: 'move' },
];

export function TopBar({ onOpenAdmin, updateWaiting = false, trialDaysLeft = null }: {
  onOpenAdmin: () => void;
  /** a newer build is downloaded-able — a dot on the cog, nothing louder */
  updateWaiting?: boolean;
  /** days until a trial ends, or null when this is not a trial */
  trialDaysLeft?: number | null;
}) {
  const snap = useStore((s) => s.snap);
  const project = useStore((s) => s.project)!;
  const connected = useStore((s) => s.connected);
  const engineStalled = useStore((s) => s.engineStalled);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const midiInputs = useStore((s) => s.midiInputs);
  const oscLog = useStore((s) => s.oscLog);
  const learnMode = useStore((s) => s.learnMode);
  const touch = useStore((s) => s.touch);
  const helpMode = useStore((s) => s.helpMode);
  const setHelpMode = useStore((s) => s.setHelpMode);
  const send = useStore((s) => s.send);
  const savedFlash = useStore((s) => s.savedFlash);
  const pendingWrite = useStore((s) => s.pendingWrite);
  const undoDepth = useStore((s) => s.undoDepth);
  const redoDepth = useStore((s) => s.redoDepth);
  const undoLabel = useStore((s) => s.undoLabel);
  const redoLabel = useStore((s) => s.redoLabel);

  const bpm = snap?.bpm ?? 120;
  // Switched on is not the same as working: the follower reports a source only
  // while ticks are actually arriving, so an armed clock with a cable out reads
  // as waiting rather than following.
  const clockSource = snap?.midiClock?.on ? snap.midiClock.source : undefined;
  const followingClock = clockSource !== undefined;
  const beat = snap?.beat ?? 0;
  const beatOn = ((beat % 1) + 1) % 1 < 0.22;
  const barOn = ((beat % BAR) + BAR) % BAR < 1;
  const dragRef = useRef<{ y: number; bpm: number; moved: boolean } | null>(null);
  /** The typed tempo while the readout is a field; null means it is a readout. */
  const [bpmEdit, setBpmEdit] = useState<string | null>(null);
  const commitBpm = (raw: string) => {
    setBpmEdit(null);
    const v = Number(raw.trim());
    // A field that silently ignores what was typed is worse than one that says
    // so — 20 to 500 is the clock's own range in both engines.
    if (!Number.isFinite(v) || v <= 0) return;
    send({ type: 'setBpm', bpm: clamp(v, 20, 500) });
  };

  const oscAlive = oscLog.length > 0 && Date.now() - oscLog[0].t < 3000;
  // engineStalled comes from snapshot ARRIVAL time. The fps figure below only
  // catches a slowdown: it travels inside the snapshot, so a tick loop that
  // stops entirely freezes it at its last healthy value and the dot stays green.
  const engineOk = connected && !engineStalled && (snap?.stats.fps ?? 0) >= 35;
  const editingDeckId = useStore((st) => st.editingDeckId);
  const editingSong = (project.decks ?? []).find((d) => d.id === editingDeckId) ?? null;
  const justSaved = Date.now() - savedFlash < 1500;

  // --- the strip measures itself (design 2.1) ------------------------------
  // The bar used to wrap: `flex-wrap: wrap` put ALL STOP and BLACKOUT at the
  // far left of a second row at 1440, split them across a line break on the
  // tablet, and on the phone they landed on row three of eight. A control you
  // reach for without looking cannot move, so the panic pair now has a track of
  // its own at the right edge and the rest of the strip gives way in a stated
  // order until what is left fits. Measured rather than set at breakpoints, so
  // no window width can be caught between two of them with a strip that
  // overflows.
  const flowRef = useRef<HTMLDivElement>(null);
  const [steps, setSteps] = useState(0);
  const [, setTick] = useState(0);
  useEffect(() => {
    const el = flowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = flowRef.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && steps < DROP_STEPS.length) setSteps(steps + 1);
    // Only take a control back when there is room to spare, or a width sitting
    // exactly on the boundary would drop and restore it on every frame.
    else if (over <= -RESTORE_SLACK && steps > 0) setSteps(steps - 1);
  });
  const applied = DROP_STEPS.slice(0, steps);
  const moved = new Set(applied.filter((s) => s.kind === 'move').map((s) => s.id));
  const shrunk = new Set(applied.filter((s) => s.kind === 'shrink').map((s) => s.id));

  // --- the controls, once each, wherever they end up -----------------------
  const speedFader = (
    <Fader
      key="speed"
      label="speed"
      width={92}
      min={-2}
      max={2}
      def={0}
      value={Math.log2(snap?.speed ?? 1)}
      fmt={(v) => `${Math.pow(2, v).toFixed(2)}×`}
      onChange={(v) => send({ type: 'setSpeed', v: Math.pow(2, v) })}
      learn={{ kind: 'speed' }}
      variant="dim"
    />
  );
  const hazeFader = (
    <Fader
      key="haze"
      label="haze"
      width={86}
      value={snap?.haze ?? 0}
      onChange={(v) => send({ type: 'setHaze', v })}
      def={0}
      learn={{ kind: 'haze' }}
      variant="dim"
    />
  );
  const syncKey = (
    <button
      key="sync"
      className="btn small ghost"
      onClick={() => send({ type: 'resync' })}
      title="press it on the downbeat — the bar count and every effect cycle start again from here"
    >
      sync
    </button>
  );
  // Hold it and the frame is held only while your finger is down; click it and
  // it latches (design 2.1, A29 — MagicQ's Preload is the same key). The two are
  // one gesture told apart by how long the press lasted, so there is nothing
  // extra on the strip and nothing to learn.
  //
  // A held freeze is OWNED by this client, so if this window goes away mid-hold
  // the engine releases it. A latch is a deliberate choice and outlives us.
  const freezeDown = useRef(0);
  const freezeKey = (
    <button
      key="freeze"
      className={`btn ${snap?.frozen ? 'warn on' : 'ghost'}`}
      title={
        snap?.frozen
          ? 'HELD — the rig is repeating the frame it was on. The show, the pads and the stage view are all still running, so you can set up the next column without the room watching you do it. Click to let it through. Blackout and ALL STOP release it on their own.'
          : 'hold the rig on the frame it is showing, set up the next column, then release — or click to latch it. The stage view keeps following your edits; the room does not see them until you let it through.'
      }
      onPointerDown={(e) => {
        if (e.button !== 0 || snap?.frozen) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        freezeDown.current = performance.now();
        send({ type: 'setFreeze', v: true, momentary: true });
      }}
      onPointerUp={() => {
        if (!freezeDown.current) return;
        const heldFor = performance.now() - freezeDown.current;
        freezeDown.current = 0;
        // A short press is a click, and a click latches: leave it held, and
        // drop the ownership so it survives this window going away.
        if (heldFor < motion['hold-latch']) send({ type: 'setFreeze', v: true });
        else send({ type: 'setFreeze', v: false });
      }}
      onPointerCancel={() => {
        if (!freezeDown.current) return;
        freezeDown.current = 0;
        send({ type: 'setFreeze', v: false });
      }}
      onClick={() => { if (snap?.frozen && !freezeDown.current) send({ type: 'setFreeze', v: false }); }}
    >
      {snap?.frozen ? 'held' : 'freeze'}
    </button>
  );

  const stripRest = (
    <>
      {!moved.has('wordmark') && (
        <div className="wordmark" title={`LIGHT v${__APP_VERSION__}`}>
          LIGHT<span><Glyph name="bolt" /></span>
        </div>
      )}
      {/* While the grid is showing a song the room is not playing, the name
          slot says so. A state in which a pad body withholds a cue has to be
          readable from the top of the screen as well as from the grid — it is
          the one place the eye goes when something does not happen (design
          section 8, rule 18). */}
      {editingSong ? (
        <button
          className="btn small warn on"
          title={`the grid is showing ${editingSong.name}, which is not what is playing — nothing on it reaches the rig. Escape comes back.`}
          onClick={() => useStore.getState().setEditingDeckId(null)}
        >
          editing: {editingSong.name}
        </button>
      ) : (
        <ProjectMenu name={project.name} short={shrunk.has('project')} />
      )}
      {/* Left, next to the project menu: the right end of this bar is where
          things get squeezed on a laptop, and a view switcher that scrolls out
          of reach is worse than no view switcher. */}
      <div className="seg viewseg" role="group" aria-label="layout">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={view === v.id ? 'on' : ''}
            title={`${v.title}  (⌥${v.key})`}
            aria-pressed={view === v.id}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="bpmblock">
        {/* the bar lamp is the beat lamp one step up — both read --size-lamp,
            so the pair scales with the rest of the desk's lamps rather than
            with a number typed here (design R7) */}
        <div className={`beatled bar ${beatOn && barOn ? 'on' : ''}`} />
        <div className={`beatled ${beatOn ? 'on' : ''}`} />
        {bpmEdit === null ? (
          <div
            className={`bpm ${followingClock ? 'followed' : ''}`}
            role={followingClock ? undefined : 'button'}
            tabIndex={followingClock ? undefined : 0}
            title={
              followingClock
                ? `tempo is coming from ${clockSource} — switch the beat clock off to set it here`
                : 'drag to adjust the tempo, or click to type it'
            }
            onPointerDown={(e) => {
              if (followingClock) return;
              // Where a click ends up being a click and not a drag is decided
              // on pointerUP, by how far it moved: a scrub and a click both
              // start here, and demanding a double-click to type would make
              // the obvious gesture the wrong one.
              dragRef.current = { y: e.clientY, bpm, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragRef.current && e.buttons & 1) {
                const d = (dragRef.current.y - e.clientY) * 0.25;
                if (Math.abs(d) >= 0.5) dragRef.current.moved = true;
                if (dragRef.current.moved) send({ type: 'setBpm', bpm: clamp(dragRef.current.bpm + d, 20, 500) });
              }
            }}
            onPointerUp={() => {
              const scrubbed = dragRef.current?.moved ?? false;
              dragRef.current = null;
              if (!scrubbed) setBpmEdit(bpm.toFixed(1));
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              setBpmEdit(bpm.toFixed(1));
            }}
          >
            {bpm.toFixed(1)}
          </div>
        ) : (
          <input
            className="bpm bpmedit"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the click that opened it asked for the caret
            autoFocus
            aria-label="tempo in BPM"
            title="Enter to set it, Escape to leave it alone"
            value={bpmEdit}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setBpmEdit(e.target.value)}
            onBlur={() => commitBpm(bpmEdit)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBpm(bpmEdit);
              // Escape leaves the tempo where it was — the one gesture that
              // has to be safe on a control this size during a show.
              else if (e.key === 'Escape') setBpmEdit(null);
            }}
          />
        )}
        <span className="label">bpm</span>
        <button
          className="btn small"
          disabled={followingClock}
          title={
            followingClock
              ? `${clockSource} is setting the tempo — a tap here would be overwritten on the next frame`
              : 'tap the beat — four taps sets the tempo, and every tap also lands the downbeat (keyboard: T)'
          }
          onClick={() => {
            if (!useStore.getState().armLearn({ kind: 'tap' })) send({ type: 'tap' });
          }}
        >
          tap
        </button>
        {!moved.has('sync') && syncKey}
      </div>

      {!moved.has('speed') && speedFader}
      {!moved.has('haze') && hazeFader}
      <Fader
        label="master"
        width={shrunk.has('master') ? size['master-w-narrow'] : 130}
        value={snap?.master ?? 1}
        onChange={(v) => send({ type: 'setMaster', v })}
        def={1}
        learn={{ kind: 'grand' }}
        variant="dim"
      />
      {(() => {
        // The transmit gate. LIGHT boots offline every time, so this is the one
        // deliberate step between opening a show and putting DMX on somebody's
        // network — and the state has to be readable from across a room.
        //
        // Amber when output is configured but nothing is going out: that is the
        // confusing case ("I set up Art-Net, why is there no light?"), and it
        // is the one this button exists to answer. With no universe enabled
        // there is nothing to send either way, so it stays quiet.
        const configured = project.universes.some((u) => u.artnet || u.sacn);
        const live = snap?.transmit === true;
        return (
          <button
            className={`btn ${live ? 'on' : configured ? 'warn on' : ''}`}
            title={
              live && !configured
                ? 'Live, but no universe is set up to send — so nothing is reaching the rig anyway. Turn on Art-Net or sACN in the Output tab.'
                : live
                ? 'LIVE — the rig is receiving. Click to go offline: LIGHT sends a blackout, then stops transmitting entirely, and the show keeps running on screen.'
                : configured
                  ? 'OFFLINE — nothing is reaching the rig. The universes are set up; click to go live.'
                  : 'OFFLINE — nothing is reaching the rig, and no universe is set up to send anyway. Turn on Art-Net or sACN in the Output tab first.'
            }
            // With no universe set up there is nothing to go live TO, so the
            // button stops being a gate and becomes the way to the thing that
            // is missing — the design's one place the sentence is said.
            onClick={() => (configured ? send({ type: 'setTransmit', v: !live }) : openSetup('output'))}
          >
            {live ? 'live' : 'offline'}
          </button>
        );
      })()}
      {/* Freeze. Beside the transmit gate because they are the same question
          asked twice: is the rig following me, and if not, why not. */}
      {!moved.has('freeze') && freezeKey}
    </>
  );

  return (
    <div className="commandbar">
      <div className="commandstrip panel">
        <div className="stripflow" ref={flowRef}>{stripRest}</div>
        {/* Its own track, right-anchored, at the same x on every view and every
            window width. Nothing may share it. */}
        <div className="panic">
          <button
            className="btn allstop"
            title="ALL STOP — blackout, clear every layer, release holds, haze and motors off"
            onClick={() => {
              void askConfirm('All stop?', {
                body: 'Blackout on, every layer cleared, holds released, haze off. Use this when something must stop NOW.',
                confirmLabel: 'ALL STOP',
                danger: true,
              }).then((ok) => {
                if (ok) {
                  send({ type: 'allStop' });
                  // panic also disarms ride and drops in-flight fader events, so a
                  // drag mid-gesture cannot re-create the rides just cleared
                  useStore.setState({ ride: false, rideCutAt: Date.now() });
                }
              });
            }}
          >
            all stop
          </button>
          <button
            className={`btn blackout ${snap?.blackout ? 'hot' : ''}`}
            title="blackout — zeroes intensity and strobe instantly and always wins, while layers keep running underneath. Press again to restore (keyboard: B)."
            onClick={() => {
              if (!useStore.getState().armLearn({ kind: 'blackout' })) send({ type: 'setBlackout', v: !snap?.blackout });
            }}
          >
            blackout
          </button>
        </div>
      </div>

      {/* The status line: what performs nothing. In Pads it keeps only what
          says something about the rig — the held chip, the lamps and the two
          ways in — because the grid is what that view is for. Anything the
          strip handed down stays here in every view, or a narrow window would
          put a control out of reach entirely. */}
      <div className={`statusline ${view === 'pads' ? 'folded' : ''}`}>
        <div className="lineflow">
          {moved.has('sync') && syncKey}
          {moved.has('speed') && speedFader}
          {moved.has('haze') && hazeFader}
          {moved.has('freeze') && freezeKey}
        </div>
        <div className="linequiet">
          {/* Not a button any more (design 2.1): edits autosave, the engine
              holds the history, and a SAVE key that is "only for peace of
              mind" spends strip on a question rather than answering it. The
              dot answers it — lit while an edit is still on its way to the
              engine, quiet once the engine has it, and a moment of the live
              colour when the show reaches the disk. ⌘S still writes now. */}
          <div
            className={`savedot ${pendingWrite ? 'pending' : ''} ${justSaved ? 'just' : ''}`}
            title={
              pendingWrite
                ? 'an edit is on its way to the engine'
                : justSaved
                  ? 'written to disk'
                  : 'every edit is in. The show writes itself to disk a moment after you stop; ⌘S writes it now'
            }
            role="status"
            aria-label={pendingWrite ? 'saving' : 'saved'}
          />
          <button
            className="btn small ghost"
            disabled={undoDepth === 0 || !connected}
            // Says WHAT it will revert (review M16). The history is the engine's,
            // shared by every screen, so the name is the only way to know whose
            // edit is next — and what is played rather than edited (song
            // switches, masters, nudges) is not in it.
            title={
              !connected
                ? 'undo needs the engine'
                : undoDepth === 0
                  ? 'nothing to undo. Edits from any screen are steps — pads, looks, songs, the rig, imports; what you play (song switches, masters, nudges) is not'
                  : `undo ${undoLabel ?? 'the last edit'} (⌘Z)`
            }
            aria-label={undoDepth === 0 ? 'nothing to undo' : `undo ${undoLabel ?? 'the last edit'}`}
            onClick={() => useStore.getState().undo()}
          >
            <Glyph name="prev" alone />
          </button>
          <button
            className="btn small ghost"
            disabled={redoDepth === 0 || !connected}
            title={!connected ? 'redo needs the engine' : redoDepth === 0 ? 'nothing to redo' : `redo ${redoLabel ?? 'the last undone edit'} (⇧⌘Z)`}
            aria-label={redoDepth === 0 ? 'nothing to redo' : `redo ${redoLabel ?? 'the last undone edit'}`}
            onClick={() => useStore.getState().redo()}
          >
            <Glyph name="next" alone />
          </button>
          <button
            className={`btn small ${project.sync.linkEnabled ? 'on' : ''}`}
            title={
              snap?.link
                ? 'Ableton Link — follow/lead the session tempo'
                : 'Ableton Link runs in the native engine (packaged app / rust core)'
            }
            onClick={() => send({ type: 'setLink', on: !project.sync.linkEnabled })}
          >
            link{project.sync.linkEnabled && snap?.link ? ` ${snap.link.peers}` : ''}
          </button>
          <button
            className={`btn small ${project.sync.midiClockEnabled ? (followingClock ? 'on' : 'warn on') : ''}`}
            title={
              !snap?.midiClock
                ? 'MIDI beat clock runs in the native engine (packaged app / rust core)'
                : followingClock
                  ? `following the beat clock from ${clockSource}`
                  : project.sync.midiClockEnabled
                    ? 'waiting for a beat clock — no input is sending one'
                    : 'take the tempo from a MIDI beat clock, whichever input is sending one'
            }
            onClick={() => send({ type: 'setMidiClock', on: !project.sync.midiClockEnabled })}
          >
            clock
          </button>
          <button
            className={`btn small warn ${learnMode ? 'on' : ''}`}
            title="MIDI learn: arm, click any pad, dial or fader, then move/press your controller"
            onClick={() => useStore.getState().toggleLearnMode()}
          >
            midi learn
          </button>
        </div>

        {/* Kept in every view: one chip for everything holding the rig away
            from the show, and the lamps that say whether it is listening. */}
        <div className="linekeep">
          <TintKey />
          <HeldChip />
          {trialDaysLeft !== null && trialDaysLeft <= 3 && (
            <button
              className="warnchip"
              title="your trial is nearly over — enter a licence key in settings to keep going"
              onClick={onOpenAdmin}
            >
              {trialDaysLeft === 0 ? 'trial ends today' : trialDaysLeft === 1 ? 'trial ends tomorrow' : `trial ends in ${trialDaysLeft} days`}
            </button>
          )}
          <div className="statusdots">
            <StatusDot
              ok={engineOk}
              // A stalled or lost engine is a fault, not a shade of grey: the
              // watchdog's own state paints the dot, so "engine 40fps" can
              // never be read off a snapshot that stopped arriving.
              bad={!connected || engineStalled}
              warn={connected && !engineStalled && !engineOk}
              label={!connected ? 'no engine' : engineStalled ? 'engine stalled' : `engine ${snap?.stats.fps ?? 0}fps`}
              title={
                !connected
                  ? 'the engine is not responding — commands are not reaching the rig'
                  : engineStalled
                    ? 'connected, but snapshots have stopped arriving — the tick loop is wedged and nothing you press is reaching the rig'
                    : 'engine tick rate'
              }
            />
            {(() => {
              // One dot for the rig, whichever wire it is on (review M2/M3). "sending"
              // reflects the CURRENT config, not the cumulative packet counter — a
              // warn dot must clear when Art-Net is disabled. sACN is multicast
              // with no reply, so an sACN-only rig reads as sending: that is what
              // LIGHT is doing, and the tooltip says it cannot know what arrived.
              const artnetOn = project.universes.some((u) => u.artnet);
              const sacnOn = project.universes.some((u) => u.sacn);
              const nodes = snap?.artnetNodes ?? [];
              const fresh = nodes.filter((n) => n.ageMs < 8000);
              const failed = snap?.artnetPoll === 'failed';
              const wire = artnetOn && sacnOn ? 'Art-Net + sACN' : artnetOn ? 'Art-Net' : 'sACN';
              // The gate comes first: with it shut nothing is being sent, whatever
              // the universes say, and a dot reading "sending" would be a lie an
              // operator would believe while the rig sat dark.
              if ((artnetOn || sacnOn) && snap?.transmit !== true) {
                return (
                  <StatusDot
                    ok={false}
                    warn
                    label="not sending"
                    title={`set up for ${wire}, but LIGHT is offline — nothing is reaching the rig. Go live with the button to the left.`}
                  />
                );
              }
              const label = !artnetOn && !sacnOn
                ? 'output off'
                : fresh.length > 0
                  ? `sending ·${fresh.length}`
                  : artnetOn && failed
                    ? 'no discovery'
                    : artnetOn
                      ? sacnOn ? 'sacn · no art-net reply' : 'no reply'
                      : 'sending sacn';
              const title = !artnetOn && !sacnOn
                ? 'Output is off on every universe — the stage shows what the rig would do. Turn on Art-Net or sACN in the Output tab.'
                : fresh.length
                  ? `sending ${wire} — ` + fresh.map((n) => `${n.name} (${n.ip})`).join(', ')
                  : artnetOn && failed
                    ? 'Art-Net discovery unavailable — port 6454 is held by another app (QLC+? a second engine?)'
                    : artnetOn
                      ? 'sending Art-Net, but no node has answered — check the network and node power'
                      : 'sending sACN (E1.31) — multicast has no reply, so this is what LIGHT is doing, not what arrived';
              return (
                <StatusDot
                  ok={fresh.length > 0 || (sacnOn && !artnetOn)}
                  warn={artnetOn && fresh.length === 0}
                  label={label}
                  title={title}
                />
              );
            })()}
            {/* MIDI and OSC now say the same kind of thing: solid when the port
                is there, brighter while something is arriving. Before this one
                was presence and the other activity, so a quiet OSC link and an
                unplugged controller looked identical. */}
            <StatusDot
              ok={midiInputs.length > 0}
              label="midi"
              title={
                midiInputs.length > 0
                  ? `listening to ${midiInputs.join(', ')}`
                  : 'no MIDI input — nothing is plugged in, or the browser was refused access'
              }
            />
            <StatusDot
              ok={snap?.oscIn !== 'failed'}
              bad={snap?.oscIn === 'failed'}
              traffic={oscAlive}
              label="osc"
              title={
                snap?.oscIn === 'failed'
                  ? 'OSC port could not be opened — another app is holding it (a second engine? QLC+?), so nothing from Resolume can arrive. Toggle OSC off and on in the Output tab once it is free.'
                  : oscAlive
                    ? 'osc — receiving'
                    : 'osc — listening, nothing received in the last 3s'
              }
            />
          </div>

          {/* On every pointer, not only on glass (design R5). A hover tooltip
              answers "what is this" for a mouse, but it will not stay still to
              be read, it never carries the long half of a tiered help string,
              and the one control that explains the rest of them should not be
              the one control you cannot find. Armed, the next press on anything
              shows its help instead of operating it — HelpMode swallows it. */}
          <button
            className={`btn ghost help ${helpMode ? 'on' : ''}`}
            title={
              touch
                ? 'help — tap this, then tap any control to read what it does'
                : 'help — click this, then click any control to read what it does. The keyboard and gesture sheet is ?'
            }
            aria-label={helpMode ? 'help is on — press any control to read it' : 'help'}
            aria-pressed={helpMode}
            onClick={() => setHelpMode(!helpMode)}
          >
            ?
          </button>
          <button
            className="btn ghost cog"
            title={
              updateWaiting
                ? 'settings — an update is waiting. Output, sync, display, the lock, the licence, updates, and the setup steps'
                : 'settings — output, sync, display, the lock, the licence, updates, and the setup steps'
            }
            aria-label={updateWaiting ? 'settings, update waiting' : 'settings'}
            onClick={onOpenAdmin}
          >
            <Glyph name="cog" alone />{updateWaiting && <i className="badge" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Slack before a control the strip handed down is taken back, so a window
 *  resting on the boundary cannot flip one up and down every frame. */
const RESTORE_SLACK = 40;
