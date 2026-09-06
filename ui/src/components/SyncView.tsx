import React from 'react';
import type { MidiAction, Project } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { NumInput } from './inputs.tsx';
import { askConfirm } from '../dialog.tsx';
import { apc40Mk2Mappings, apcMiniMk2Mappings } from '../controllerPresets.ts';

function describeAction(p: Project, a: MidiAction): string {
  switch (a.kind) {
    case 'cell': {
      const layer = p.layers.find((l) => l.id === a.layerId);
      const lookId = layer?.cells[a.col];
      const look = lookId ? p.looks[lookId] : null;
      return `Pad ${layer?.name ?? '?'} · ${a.col + 1}${look ? ` (${look.name})` : ''}`;
    }
    case 'column':
      return `Column ${a.col + 1}`;
    case 'layerMaster':
      return `Layer master · ${p.layers.find((l) => l.id === a.layerId)?.name ?? '?'}`;
    case 'layerClear':
      return `Clear layer · ${p.layers.find((l) => l.id === a.layerId)?.name ?? '?'}`;
    case 'control':
      return `Dial · ${p.controls?.find((c) => c.id === a.controlId)?.name ?? a.controlId}`;
    case 'submaster':
      return `Group level · ${p.groups.find((g) => g.id === a.groupId)?.name ?? a.groupId}`;
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
    case 'deckNext':
      return 'Next song';
    case 'deckPrev':
      return 'Previous song';
  }
}

export function SyncView() {
  const project = useStore((s) => s.project)!;
  const oscLog = useStore((s) => s.oscLog);
  const midiInputs = useStore((s) => s.midiInputs);
  const lastMidi = useStore((s) => s.lastMidi);
  const learnMode = useStore((s) => s.learnMode);
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const snap = useStore((s) => s.snap);
  const sync = project.sync;
  const clock = snap?.midiClock;
  const clockSource = clock?.on ? clock.source : undefined;

  const editSync = (fn: (s: typeof sync) => void) => mutate((p) => fn(p.sync));

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
      <div className="col grow" style={{ maxWidth: 520 }}>
        <div className="sectionhead">Resolume link</div>
        <div className="row">
          <button
            className={`btn small ${sync.oscEnabled ? 'on' : ''}`}
            title="listen for OSC on the port beside this. Resolume drives tempo and cues through it; off means LIGHT ignores the network entirely."
            onClick={() => editSync((s) => (s.oscEnabled = !s.oscEnabled))}
          >
            {sync.oscEnabled ? 'listening' : 'off'}
          </button>
          <span className="label">port</span>
          <NumInput
            value={sync.oscPort}
            title="UDP port the engine listens on for OSC — Arena sends here"
            min={1024}
            max={65535}
            width={72}
            onCommit={(v) => editSync((s) => (s.oscPort = v))}
          />
          <button className={`btn small ${sync.followColumns ? 'on' : ''}`} onClick={() => editSync((s) => (s.followColumns = !s.followColumns))}
            title="Resolume column launches fire the matching LIGHT cue">
            follow columns
          </button>
          <button className={`btn small ${sync.bpmFromOsc ? 'on' : ''}`} onClick={() => editSync((s) => (s.bpmFromOsc = !s.bpmFromOsc))}
            title="take tempo and downbeat from Arena instead of the tap clock">
            bpm from resolume
          </button>
        </div>
        <div className="prose">
          Arena ▸ Preferences ▸ OSC → enable <b>OSC Output</b>, address <b>127.0.0.1</b>, port <b>{sync.oscPort}</b>.
          Column launches then fire the matching column here, and Arena's BPM drives all effects.
          Extra addresses: /light/bpm (float) · /light/column (int, 1-based) · /light/blackout (0/1).
        </div>
        <div className="sectionhead" style={{ marginTop: 10 }}>Incoming from Arena</div>
        <div className="oscmon">
          {oscLog.length === 0 && <span style={{ color: 'var(--text-faint)' }}>waiting for Arena…</span>}
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
            midiInputs.map((n) => (
              <span key={n} className="chip" title={`${n} — an input LIGHT is listening on`}>{n}</span>
            ))
          )}
          <div className="grow" />
          <span className="label" style={{ fontFamily: 'var(--mono)' }}>{lastMidi ?? ''}</span>
        </div>
        {snap?.midiPort && (
          <div className="prose">
            A DAW on this Mac needs no bus of its own. LIGHT publishes a MIDI port called{' '}
            <b>{snap.midiPort}</b> while it is running, so it is already in the DAW's list of MIDI
            outputs — point a track at it and learn a pad from a note. Beat clock sent there
            drives the tempo too. It is a destination, not an input, which is why it is not listed
            above.
          </div>
        )}

        <div className="sectionhead" style={{ marginTop: 10 }}>Beat clock</div>
        <div className="row">
          <button
            className={`btn small ${sync.midiClockEnabled ? (clockSource ? 'on' : 'warn on') : ''}`}
            disabled={!clock}
            title={
              clock
                ? 'take the tempo from a MIDI beat clock — the first input to send one owns it until it goes quiet'
                : 'the beat clock runs in the native engine (packaged app / rust core)'
            }
            onClick={() => send({ type: 'setMidiClock', on: !sync.midiClockEnabled })}
          >
            {sync.midiClockEnabled ? 'following' : 'off'}
          </button>
          {sync.midiClockEnabled && (
            <span className="label">
              {clockSource ? (
                <>
                  tempo from <b>{clockSource}</b>
                </>
              ) : (
                'waiting — no input is sending one'
              )}
            </span>
          )}
        </div>
        <div className="prose">
          Twenty-four ticks to the beat, and nothing else in the message — so the tempo is the
          interval between them, averaged over a whole beat to keep the rig from shivering. A start
          message also lands the downbeat; a stop leaves the tempo where it was, because a stall is
          not a tempo change. Nothing to set up: switch it on and the first input sending clock owns
          the tempo until it goes quiet.
          {sync.linkEnabled && ' Ableton Link is on, and only one of the two can drive the tempo — switching this on turns Link off.'}
          {sync.bpmFromOsc && ' Arena is also set to drive the tempo, and while the beat clock is following it wins.'}
        </div>
        <div className="prose">
          {learnMode
            ? 'LEARN ARMED — click a pad, column, or fader, then press/move the control on your device.'
            : 'Click MIDI LEARN in the top bar, click any pad / column / fader, then touch your controller.'}
        </div>
        <div className="row">
          <button
            className="btn small"
            title="top 4 grid rows → layers (the bottom row is the control row, left unmapped) · 8 device knobs → the 8 dials, on every track-selection bank · scene buttons → layer clears · STOP ALL CLIPS → blackout · TAP → tempo · bank ◀ ▶ → prev / next song · track faders 1–4 → layer masters, 6 → haze, 7 → speed · master → grand"
            onClick={() => {
              void (async () => {
                const ok = await askConfirm('Load the APC40 mk2 preset?', {
                  body: 'This replaces all current MIDI mappings.',
                  confirmLabel: 'Load preset',
                });
                if (!ok) return;
                mutate((p) => {
                  p.midi = apc40Mk2Mappings(p);
                });
              })();
            }}
          >
            load APC40 mk2 preset
          </button>
          <button
            className="btn small ghost"
            title="4 grid rows → layers · bottom row → column cues · round buttons → layer clears · TAP + blackout keys · faders → 4 layer masters, haze, speed, grand"
            onClick={() => {
              void (async () => {
                const ok = await askConfirm('Load the APC mini mk2 preset?', {
                  body: 'This replaces all current MIDI mappings.',
                  confirmLabel: 'Load preset',
                });
                if (!ok) return;
                mutate((p) => {
                  p.midi = apcMiniMk2Mappings(p);
                });
              })();
            }}
          >
            APC mini mk2
          </button>
          <span className="label">load a controller layout (hover a preset for its map), or MIDI-learn any control on its own</span>
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
                    title="delete this MIDI mapping"
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
