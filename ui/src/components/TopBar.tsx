import React, { useEffect, useRef, useState } from 'react';
import { useStore, type ViewMode } from '../store.ts';
import { askConfirm, askPrompt } from '../dialog.tsx';
import { Fader } from './Fader.tsx';
import { clamp } from '../../../shared/types.ts';

function StatusDot({ ok, label, warn, title }: { ok: boolean; label: string; warn?: boolean; title?: string }) {
  return (
    <div className="dotline" title={title ?? label}>
      <div className={`statusdot ${ok ? 'ok' : warn ? 'warn' : ''}`} />
      <span className="label">{label}</span>
    </div>
  );
}

function ProjectMenu({ name }: { name: string }) {
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
    // Position the dropdown with the viewport, not the top bar: the bar is an
    // overflow scroll container (narrow-window survival), which clips an
    // absolutely-positioned child to its own 46px height. A fixed element
    // computed from the button's rect escapes that box.
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
      <button ref={btnRef} className="btn small ghost projname" title="projects" onClick={openMenu}>
        {name} ▾
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
              {p.slug === projects?.current ? '✓ ' : ''}{p.name}
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
  const undoDepth = useStore((s) => s.undoDepth);
  const redoDepth = useStore((s) => s.redoDepth);
  const undoLabel = useStore((s) => s.undoLabel);
  const redoLabel = useStore((s) => s.redoLabel);

  const bpm = snap?.bpm ?? 120;
  const beat = snap?.beat ?? 0;
  const beatOn = ((beat % 1) + 1) % 1 < 0.22;
  const barOn = ((beat % 4) + 4) % 4 < 1;
  const dragRef = useRef<{ y: number; bpm: number } | null>(null);

  const oscAlive = oscLog.length > 0 && Date.now() - oscLog[0].t < 3000;
  // engineStalled comes from snapshot ARRIVAL time. The fps figure below only
  // catches a slowdown: it travels inside the snapshot, so a tick loop that
  // stops entirely freezes it at its last healthy value and the dot stays green.
  const engineOk = connected && !engineStalled && (snap?.stats.fps ?? 0) >= 35;
  const justSaved = Date.now() - savedFlash < 1500;

  return (
    <div className="topbar panel">
      <div className="wordmark" title={`LIGHT v${__APP_VERSION__}`}>
        LIGHT<span>■</span>
      </div>
      <ProjectMenu name={project.name} />
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
      <button
        className="btn small ghost"
        title="write the show to disk now (⌘S). Edits autosave about a second after you stop, so this is only for peace of mind."
        onClick={() => send({ type: 'save' })}
      >
        {justSaved ? 'saved ✓' : 'save'}
      </button>
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
        ↺
      </button>
      <button
        className="btn small ghost"
        disabled={redoDepth === 0 || !connected}
        title={!connected ? 'redo needs the engine' : redoDepth === 0 ? 'nothing to redo' : `redo ${redoLabel ?? 'the last undone edit'} (⇧⌘Z)`}
        aria-label={redoDepth === 0 ? 'nothing to redo' : `redo ${redoLabel ?? 'the last undone edit'}`}
        onClick={() => useStore.getState().redo()}
      >
        ↻
      </button>

      <div className="grow" />

      <div className="bpmblock">
        <div className={`beatled ${beatOn && barOn ? 'on' : ''}`} style={{ width: 10, height: 10 }} />
        <div className={`beatled ${beatOn ? 'on' : ''}`} />
        <div
          className="bpm"
          title="drag to adjust BPM"
          onPointerDown={(e) => {
            dragRef.current = { y: e.clientY, bpm };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragRef.current && e.buttons & 1) {
              const d = (dragRef.current.y - e.clientY) * 0.25;
              send({ type: 'setBpm', bpm: clamp(dragRef.current.bpm + d, 20, 500) });
            }
          }}
          onPointerUp={() => (dragRef.current = null)}
        >
          {bpm.toFixed(1)}
        </div>
        <span className="label">bpm</span>
        <button
          className="btn small"
          title="tap the beat — four taps sets the tempo, and every tap also lands the downbeat (keyboard: T)"
          onClick={() => {
            if (!useStore.getState().armLearn({ kind: 'tap' })) send({ type: 'tap' });
          }}
        >
          tap
        </button>
        <button className="btn small ghost" onClick={() => send({ type: 'resync' })} title="snap phase to downbeat">
          sync
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
        <Fader
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
      </div>

      <div className="grow" />

      <Fader
        label="haze"
        width={86}
        value={snap?.haze ?? 0}
        onChange={(v) => send({ type: 'setHaze', v })}
        def={0}
        learn={{ kind: 'haze' }}
        variant="dim"
      />
      <Fader
        label="master"
        width={130}
        value={snap?.master ?? 1}
        onChange={(v) => send({ type: 'setMaster', v })}
        def={1}
        learn={{ kind: 'grand' }}
      />
      {(snap?.muted?.length ?? 0) > 0 && (
        <span className="mutedchip" title="fixtures silenced — they are receiving all zeros">
          {snap!.muted!.length} muted
        </span>
      )}
      {(snap?.unknownProfiles?.length ?? 0) > 0 && (
        <span
          className="mutedchip"
          title="these fixtures reference a profile that no longer exists — they render as nothing at all. Re-import the fixture profile, or re-assign them in Fixtures."
        >
          {snap!.unknownProfiles!.length} dark (no profile)
        </span>
      )}
      {(snap?.overrides ?? 0) > 0 && (
        <span
          className="mutedchip"
          title="raw channel overrides are held from the Output tab — the show is not driving those channels"
        >
          {snap!.overrides} override{snap!.overrides === 1 ? '' : 's'}
        </span>
      )}
      {snap?.identify && (
        // Identify drives a fixture to full white and overrides EVERYTHING,
        // blackout included — so it must never be a thing you can leave on
        // without seeing it. This chip shows it from any tab and clears it on
        // click; blackout and 'B' will not touch it, only this or ALL STOP.
        <span
          className="mutedchip identifychip"
          title="a fixture is held at full white so you can find it — it ignores blackout. Click to release it."
          onClick={() => send({ type: 'identify', fixtureId: null })}
          style={{ cursor: 'pointer' }}
        >
          ◎ finding: {project.fixtures.find((f) => f.id === snap.identify)?.name ?? 'fixture'}
        </span>
      )}
      {(snap?.soft?.length ?? 0) > 0 && (
        <span
          className="chip nudgechip"
          title="live nudges are driving the rig — Keep writes them into the show, Discard drops them. Always visible here, whatever panel is open."
        >
          NUDGED {snap!.soft!.length}
          <button
            className="btn small"
            title="write these live positions into the show, so the looks keep them next time they fire (undoable)"
            // the engine records this as a step of its own ("keep the nudged values")
            onClick={() => send({ type: 'softCommit' })}
          >
            Keep
          </button>
          <button
            className="btn small ghost"
            title="throw the live positions away and snap back to what the looks have stored"
            onClick={() => send({ type: 'softClear' })}
          >
            Discard
          </button>
        </span>
      )}
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
            onClick={() => send({ type: 'setTransmit', v: !live })}
          >
            {live ? 'live' : 'offline'}
          </button>
        );
      })()}
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
      <button
        className={`btn warn ${learnMode ? 'on' : ''}`}
        title="MIDI learn: arm, click any pad, dial or fader, then move/press your controller"
        onClick={() => useStore.getState().toggleLearnMode()}
      >
        midi learn
      </button>
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
          warn={!connected}
          label={connected ? `engine ${snap?.stats.fps ?? 0}fps` : 'engine offline'}
          title={connected ? 'engine tick rate' : 'the engine is not responding — commands are not reaching the rig'}
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
        <StatusDot ok={midiInputs.length > 0} label="midi" />
        {/* a quiet OSC link and an unbindable port look identical from here
            unless the engine tells us the bind failed */}
        <StatusDot
          ok={oscAlive}
          warn={snap?.oscIn === 'failed'}
          label="osc"
          title={
            snap?.oscIn === 'failed'
              ? 'OSC port is held by another app (a second engine? QLC+?) — nothing from Resolume can arrive'
              : oscAlive
                ? 'osc — receiving'
                : 'osc — listening, nothing received in the last 3s'
          }
        />
      </div>

      {/* Touch mode only: the tooltips are hovers, and glass has no hover
          (review M15). Armed, the next tap on anything shows its help text
          instead of operating it — HelpMode.tsx swallows the tap. */}
      {touch && (
        <button
          className={`btn ghost help ${helpMode ? 'on' : ''}`}
          title="help — tap this, then tap any control to read what it does"
          aria-label={helpMode ? 'help is on — tap any control to read it' : 'help'}
          aria-pressed={helpMode}
          onClick={() => setHelpMode(!helpMode)}
        >
          ?
        </button>
      )}

      {/* Pinned, not just last. .topbar is a hidden-scrollbar scroll container,
          so anything appended at the right end is the first thing to slide out
          of reach on a laptop — with no scrollbar to hint it is there. The view
          switcher was moved left for exactly this reason; sticky keeps the cog
          on the visible edge instead. */}
      <button
        className="btn ghost cog"
        title={updateWaiting ? 'settings — an update is waiting' : 'settings — updates, licence'}
        aria-label={updateWaiting ? 'settings, update waiting' : 'settings'}
        onClick={onOpenAdmin}
      >
        ⚙{updateWaiting && <i className="badge" aria-hidden="true" />}
      </button>
    </div>
  );
}
