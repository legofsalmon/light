import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
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
  const send = useStore((s) => s.send);
  const projects = useStore((s) => s.projects);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    send({ type: 'projects' }); // refresh the list every time the menu opens
    const close = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open, send]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button className="btn small ghost projname" title="projects" onClick={() => setOpen((o) => !o)}>
        {name} ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 40, minWidth: 220,
            background: 'var(--panel2, #1c1c20)', border: '1px solid var(--line)',
            borderRadius: 4, padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {(projects?.list ?? []).map((p) => (
            <button
              key={p.slug}
              className={`btn small ghost ${p.slug === projects?.current ? 'on' : ''}`}
              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => {
                if (p.slug !== projects?.current) send({ type: 'openProject', slug: p.slug });
                setOpen(false);
              }}
            >
              {p.slug === projects?.current ? '✓ ' : ''}{p.name}
            </button>
          ))}
          <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
          <button
            className="btn small ghost"
            style={{ justifyContent: 'flex-start' }}
            onClick={() => {
              const n = window.prompt('New project name:');
              if (n) send({ type: 'newProject', name: n });
              setOpen(false);
            }}
          >
            + new project…
          </button>
          <button
            className="btn small ghost"
            style={{ justifyContent: 'flex-start' }}
            onClick={() => {
              const n = window.prompt('Save current project as:', name);
              if (n) {
                const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
                const clash = projects?.list.find((p) => p.slug === slug && p.slug !== projects.current);
                if (clash && !window.confirm(`"${clash.name}" already exists — overwrite it?`)) {
                  setOpen(false);
                  return;
                }
                send({ type: 'saveProjectAs', name: n });
              }
              setOpen(false);
            }}
          >
            save as…
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const snap = useStore((s) => s.snap);
  const project = useStore((s) => s.project)!;
  const connected = useStore((s) => s.connected);
  const midiInputs = useStore((s) => s.midiInputs);
  const oscLog = useStore((s) => s.oscLog);
  const learnMode = useStore((s) => s.learnMode);
  const send = useStore((s) => s.send);
  const savedFlash = useStore((s) => s.savedFlash);
  const toast = useStore((s) => s.toast);
  const undoDepth = useStore((s) => s.undoDepth);
  const redoDepth = useStore((s) => s.redoDepth);

  const bpm = snap?.bpm ?? 120;
  const beat = snap?.beat ?? 0;
  const beatOn = ((beat % 1) + 1) % 1 < 0.22;
  const barOn = ((beat % 4) + 4) % 4 < 1;
  const dragRef = useRef<{ y: number; bpm: number } | null>(null);

  const oscAlive = oscLog.length > 0 && Date.now() - oscLog[0].t < 3000;
  const engineOk = connected && (snap?.stats.fps ?? 0) >= 35;
  const justSaved = Date.now() - savedFlash < 1500;

  return (
    <div className="topbar panel">
      <div className="wordmark">
        LIGHT<span>■</span>
      </div>
      <ProjectMenu name={project.name} />
      <button className="btn small ghost" onClick={() => send({ type: 'save' })}>
        {justSaved ? 'saved ✓' : 'save'}
      </button>
      <button
        className="btn small ghost"
        disabled={undoDepth === 0}
        title="undo (⌘Z)"
        onClick={() => useStore.getState().undo()}
      >
        ↺
      </button>
      <button
        className="btn small ghost"
        disabled={redoDepth === 0}
        title="redo (⇧⌘Z)"
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
      <button
        className={`btn blackout ${snap?.blackout ? 'hot' : ''}`}
        onClick={() => {
          if (!useStore.getState().armLearn({ kind: 'blackout' })) send({ type: 'setBlackout', v: !snap?.blackout });
        }}
      >
        blackout
      </button>
      <button
        className={`btn warn ${learnMode ? 'on' : ''}`}
        title="MIDI learn: arm, click any control or cell, then move/press your controller"
        onClick={() => useStore.getState().toggleLearnMode()}
      >
        midi learn
      </button>
      <button
        className="btn ghost"
        title="open the native previz window"
        onClick={() => send({ type: 'launchPreviz' })}
      >
        previz
      </button>
      {toast && (
        <span className="label" style={{ color: toast.ok ? 'var(--good)' : 'var(--hot)' }}>
          {toast.text}
        </span>
      )}

      <div className="statusdots">
        <StatusDot ok={engineOk} label={`engine ${snap?.stats.fps ?? 0}fps`} />
        {(() => {
          // "sending" must reflect the CURRENT config, not the cumulative
          // packet counter — a warn dot must clear when Art-Net is disabled
          const sending = project.universes.some((u) => u.artnet);
          const nodes = snap?.artnetNodes ?? [];
          const fresh = nodes.filter((n) => n.ageMs < 8000);
          const failed = snap?.artnetPoll === 'failed';
          const label = fresh.length > 0 ? `art-net ·${fresh.length}` : 'art-net';
          const title = fresh.length
            ? fresh.map((n) => `${n.name} (${n.ip})`).join(', ')
            : failed
              ? 'discovery unavailable — UDP 6454 is held by another app'
              : sending
                ? 'sending, but no node has answered ArtPoll — check network'
                : 'art-net output is off';
          return (
            <StatusDot
              ok={fresh.length > 0}
              warn={sending && fresh.length === 0 && !failed}
              label={label}
              title={title}
            />
          );
        })()}
        <StatusDot ok={midiInputs.length > 0} label="midi" />
        <StatusDot ok={oscAlive} label="osc" />
      </div>
    </div>
  );
}
