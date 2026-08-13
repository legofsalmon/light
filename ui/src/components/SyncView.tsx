import React from 'react';
import type { MidiAction, Project } from '../../../shared/types.ts';
import { useStore } from '../store.ts';

function describeAction(p: Project, a: MidiAction): string {
  switch (a.kind) {
    case 'cell': {
      const layer = p.layers.find((l) => l.id === a.layerId);
      const lookId = layer?.cells[a.col];
      const look = lookId ? p.looks[lookId] : null;
      return `Cell ${layer?.name ?? '?'} · ${a.col + 1}${look ? ` (${look.name})` : ''}`;
    }
    case 'column':
      return `Column ${a.col + 1}`;
    case 'layerMaster':
      return `Layer master · ${p.layers.find((l) => l.id === a.layerId)?.name ?? '?'}`;
    case 'layerClear':
      return `Clear layer · ${p.layers.find((l) => l.id === a.layerId)?.name ?? '?'}`;
    case 'grand':
      return 'Grand master';
    case 'speed':
      return 'Effect speed';
    case 'haze':
      return 'Haze output';
    case 'tap':
      return 'Tap tempo';
    case 'blackout':
      return 'Blackout';
  }
}

export function SyncView() {
  const project = useStore((s) => s.project)!;
  const oscLog = useStore((s) => s.oscLog);
  const midiInputs = useStore((s) => s.midiInputs);
  const lastMidi = useStore((s) => s.lastMidi);
  const learnMode = useStore((s) => s.learnMode);
  const mutate = useStore((s) => s.mutate);
  const sync = project.sync;

  const editSync = (fn: (s: typeof sync) => void) => mutate((p) => fn(p.sync));

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
      <div className="col grow" style={{ maxWidth: 520 }}>
        <div className="sectionhead">Resolume sync (OSC in)</div>
        <div className="row">
          <button className={`btn small ${sync.oscEnabled ? 'on' : ''}`} onClick={() => editSync((s) => (s.oscEnabled = !s.oscEnabled))}>
            {sync.oscEnabled ? 'listening' : 'off'}
          </button>
          <span className="label">port</span>
          <input
            className="num"
            type="number"
            value={sync.oscPort}
            onChange={(e) => editSync((s) => (s.oscPort = Math.max(1024, Math.min(65535, Number(e.target.value) || 7700)))) }
          />
          <button className={`btn small ${sync.followColumns ? 'on' : ''}`} onClick={() => editSync((s) => (s.followColumns = !s.followColumns))}>
            follow columns
          </button>
          <button className={`btn small ${sync.bpmFromOsc ? 'on' : ''}`} onClick={() => editSync((s) => (s.bpmFromOsc = !s.bpmFromOsc))}>
            bpm from resolume
          </button>
        </div>
        <div className="label" style={{ lineHeight: 1.7 }}>
          Arena ▸ Preferences ▸ OSC → enable <b>OSC Output</b>, address <b>127.0.0.1</b>, port <b>{sync.oscPort}</b>.
          Column launches then fire the matching column here, and Arena's BPM drives all effects.
          Extra addresses: /light/bpm (float) · /light/column (int, 1-based) · /light/blackout (0/1).
        </div>
        <div className="sectionhead" style={{ marginTop: 10 }}>OSC monitor</div>
        <div className="oscmon">
          {oscLog.length === 0 && <span style={{ color: 'var(--text-faint)' }}>waiting for OSC…</span>}
          {oscLog.map((e, i) => (
            <div key={`${e.t}-${i}`}>
              <span className="addr">{e.addr}</span> <span className="args">{e.args.map((a) => (typeof a === 'number' ? +a.toFixed(4) : a)).join(' ')}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="col grow">
        <div className="sectionhead">MIDI</div>
        <div className="row">
          <span className="label">inputs</span>
          {midiInputs.length === 0 ? (
            <span className="label" style={{ color: 'var(--text-faint)' }}>none detected (browser needs MIDI permission)</span>
          ) : (
            midiInputs.map((n) => <span key={n} className="chip">{n}</span>)
          )}
          <div className="grow" />
          <span className="label" style={{ fontFamily: 'var(--mono)' }}>{lastMidi ?? ''}</span>
        </div>
        <div className="label" style={{ lineHeight: 1.7 }}>
          {learnMode
            ? 'LEARN ARMED — click a cell, column, or fader, then press/move the control on your device.'
            : 'Click MIDI LEARN in the top bar, click any cell / column / fader, then touch your controller.'}
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Source</th><th>Target</th><th></th></tr>
          </thead>
          <tbody>
            {project.midi.map((m) => (
              <tr key={m.id}>
                <td className="mono">
                  {m.type === 'note' ? 'Note' : 'CC'} {m.number} · ch {m.channel + 1}
                </td>
                <td>{describeAction(project, m.action)}</td>
                <td>
                  <button
                    className="btn small ghost"
                    onClick={() => mutate((p) => {
                      p.midi = p.midi.filter((x) => x.id !== m.id);
                    })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {project.midi.length === 0 && (
              <tr><td colSpan={3} style={{ color: 'var(--text-faint)' }}>no mappings yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
