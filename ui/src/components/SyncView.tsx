import React from 'react';
import type { MidiAction, MidiMapping, Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { useStore } from '../store.ts';

/**
 * Akai APC40 mk2 (generic mode 0):
 * clip grid 5×8, notes 0–39 (bottom-left = 0, rows ascend); scene launch
 * column notes 82–86 (top→bottom); track faders CC 7 on channels 0–7 (the
 * channel is the track!); master fader CC 14 ch 0; tap tempo note 99.
 *
 * Mapping: top four grid rows mirror the on-screen grid (top row = STROBE),
 * the fifth (bottom) row fires columns as cues; scene buttons 1–4 clear the
 * matching layer, scene 5 = blackout; track faders 1–4 = layer masters
 * (WASH→STROBE), 5 = haze, 6 = effect speed; master fader = grand master;
 * TAP TEMPO button = tap.
 */
function apc40Mk2Mappings(p: Project): MidiMapping[] {
  const maps: MidiMapping[] = [];
  const add = (type: 'note' | 'cc', channel: number, number: number, action: MidiAction) =>
    maps.push({ id: uid('midi'), type, channel, number, action });

  const visual = [...p.layers].reverse(); // top grid row = top layer
  visual.slice(0, 4).forEach((layer, row) => {
    const base = 32 - row * 8; // top row = notes 32–39
    for (let col = 0; col < Math.min(8, p.columns.length); col++) {
      add('note', 0, base + col, { kind: 'cell', layerId: layer.id, col });
    }
    add('note', 0, 82 + row, { kind: 'layerClear', layerId: layer.id });
  });
  for (let col = 0; col < Math.min(8, p.columns.length); col++) {
    add('note', 0, col, { kind: 'column', col }); // bottom grid row = cues
  }
  add('note', 0, 86, { kind: 'blackout' }); // scene 5, beside the cue row
  add('note', 0, 99, { kind: 'tap' }); // dedicated TAP TEMPO button
  p.layers.slice(0, 4).forEach((layer, i) => add('cc', i, 7, { kind: 'layerMaster', layerId: layer.id }));
  add('cc', 4, 7, { kind: 'haze' }); // track 5 fader
  add('cc', 5, 7, { kind: 'speed' }); // track 6 fader
  add('cc', 0, 14, { kind: 'grand' }); // master fader
  return maps;
}

/**
 * Akai APC mini mk2 factory layout (channel 0):
 * pads 0–63 (bottom-left = 0, rows ascend), scene column 112–119,
 * track faders CC 48–55, master fader CC 56.
 *
 * Mapping: top four pad rows mirror the on-screen grid (top row = top layer),
 * bottom pad row fires columns, scene buttons clear layers + tap + blackout,
 * faders 1–4 = layer masters (bottom layer first), 5 = haze, 6 = speed,
 * master fader = grand master.
 */
function apcMiniMk2Mappings(p: Project): MidiMapping[] {
  const maps: MidiMapping[] = [];
  const add = (type: 'note' | 'cc', number: number, action: MidiAction) =>
    maps.push({ id: uid('midi'), type, channel: 0, number, action });

  const visual = [...p.layers].reverse(); // top row of the UI grid first
  visual.slice(0, 4).forEach((layer, row) => {
    const base = 56 - row * 8;
    for (let col = 0; col < Math.min(8, p.columns.length); col++) {
      add('note', base + col, { kind: 'cell', layerId: layer.id, col });
    }
    add('note', 112 + row, { kind: 'layerClear', layerId: layer.id });
  });
  for (let col = 0; col < Math.min(8, p.columns.length); col++) {
    add('note', col, { kind: 'column', col });
  }
  add('note', 118, { kind: 'tap' });
  add('note', 119, { kind: 'blackout' });
  p.layers.slice(0, 4).forEach((layer, i) => add('cc', 48 + i, { kind: 'layerMaster', layerId: layer.id }));
  add('cc', 52, { kind: 'haze' });
  add('cc', 53, { kind: 'speed' });
  add('cc', 56, { kind: 'grand' });
  return maps;
}

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
        <div className="row">
          <button
            className="btn small"
            onClick={() => {
              if (!window.confirm('Load the APC40 mk2 preset? This replaces all current MIDI mappings.')) return;
              mutate((p) => {
                p.midi = apc40Mk2Mappings(p);
              });
            }}
          >
            load APC40 mk2 preset
          </button>
          <button
            className="btn small ghost"
            onClick={() => {
              if (!window.confirm('Load the APC mini mk2 preset? This replaces all current MIDI mappings.')) return;
              mutate((p) => {
                p.midi = apcMiniMk2Mappings(p);
              });
            }}
          >
            APC mini mk2
          </button>
          <span className="label">grid rows = layers · bottom row = cues · scene col = clears + blackout · faders = masters</span>
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
