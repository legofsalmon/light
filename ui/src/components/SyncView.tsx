import React from 'react';
import type { MidiAction, MidiMapping, Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { NumInput } from './inputs.tsx';
import { askConfirm } from '../dialog.tsx';
import { APC_COLS, APC_LAYER_ROWS } from '../apcFeedback.ts';

/**
 * Akai APC40 mk2 (generic mode 0):
 * clip grid 5×8, notes 0–39 (bottom-left = 0, rows ascend); scene launch
 * column notes 82–86 (top→bottom); STOP ALL CLIPS note 81; track faders CC 7
 * on channels 0–7 (the channel is the track!); master fader CC 14 ch 0; bank
 * ◀ ▶ notes 97/96; tap tempo note 99.
 *
 * Mapping (see apc40Mk2Mappings for the authority): the FOUR upper grid rows
 * mirror the on-screen layers and the bottom row is reserved for the control
 * row the look grid draws beneath them; four scene buttons clear their layer;
 * STOP ALL CLIPS = blackout (the surface's closest thing to a panic key);
 * track faders 1–4 = layer masters, 6 = haze, 7 = effect speed; master fader =
 * grand master; bank ◀ ▶ = previous / next song; TAP TEMPO = tap; the eight
 * DEVICE CONTROL knobs drive the eight Named Controls of the control row, bound
 * on every track-selection bank so the knobs cannot be banked away. (An earlier
 * layout put cues on the bottom row and blackout on a scene button — the mini
 * preset still does — so don't "restore" that here.)
 */
function apc40Mk2Mappings(p: Project): MidiMapping[] {
  const maps: MidiMapping[] = [];
  const add = (type: 'note' | 'cc', channel: number, number: number, action: MidiAction) =>
    maps.push({ id: uid('midi'), type, channel, number, action });

  // FOUR layer rows. The fifth belongs to the control row, so that the surface
  // and the screen are the same 5 x 8 shape — and so the LED feedback, which
  // lights four rows (ui/src/apcFeedback.ts, core/src/apc.rs), can never leave
  // a row that fires cues permanently dark. The bottom row is deliberately left
  // UNMAPPED rather than bound to the controls: a note drives a continuous
  // target by its velocity on press only (release is ignored so a pad release
  // cannot slam a macro to zero), so a pad could push a control to full and
  // never bring it back. Controls belong on an encoder — learn one from the
  // control row itself.
  const visual = [...p.layers].reverse(); // top grid row = top layer
  visual.slice(0, APC_LAYER_ROWS).forEach((layer, row) => {
    const base = 32 - row * 8; // top row = notes 32–39, bottom = 0–7
    for (let col = 0; col < Math.min(8, p.columns.length); col++) {
      add('note', 0, base + col, { kind: 'cell', layerId: layer.id, col });
    }
    add('note', 0, 82 + row, { kind: 'layerClear', layerId: layer.id });
  });
  // Blackout moves to STOP ALL CLIPS: the five scene buttons are now all layer
  // clears, and stop-all is the closest thing the surface has to a panic key.
  add('note', 0, 81, { kind: 'blackout' });
  add('note', 0, 99, { kind: 'tap' }); // dedicated TAP TEMPO button
  add('note', 0, 97, { kind: 'deckPrev' }); // bank ◀ = previous song page
  add('note', 0, 96, { kind: 'deckNext' }); // bank ▶ = next song page
  // Layer masters take one track fader each — and must cover the SAME four
  // layers the pad rows and the LEDs do, or a show with a fifth layer gets a
  // fader riding a layer that has no pads while the top row has no fader at
  // all. Hence: take the capped VISUAL list, then put it back in project order,
  // because track fader 1 has always been the bottom layer and flipping that
  // would move every operator's hand to the wrong fader. With four layers this
  // is exactly what it has always produced.
  visual
    .slice(0, APC_LAYER_ROWS)
    .reverse()
    .forEach((layer, i) => add('cc', i, 7, { kind: 'layerMaster', layerId: layer.id }));
  add('cc', 5, 7, { kind: 'haze' }); // track 6 fader
  add('cc', 6, 7, { kind: 'speed' }); // track 7 fader
  add('cc', 0, 14, { kind: 'grand' }); // master fader

  // The eight DEVICE CONTROL knobs (CC 0x10-0x17) drive the eight Named
  // Controls of the grid's control row — the surface's only continuous bank,
  // and the right home for a macro. Pads cannot do this job: a note drives a
  // continuous target by velocity on press only, so a pad can push a macro to
  // full and never bring it back.
  //
  // Mapped on ALL NINE channels, deliberately. In generic mode the knobs are
  // BANKED by the [TRACK SELECTION] buttons — protocol v1.2: "these knobs and
  // switches will output on a different MIDI channel based on the current Track
  // Selection (track 1 = MIDI channel 0, track 8 = MIDI channel 7, MASTER =
  // MIDI channel 8)". Bind one channel only and a stray press of a track button
  // silently kills all eight knobs mid-show. Binding every bank makes knob N
  // drive control N whatever the surface thinks is selected — LIGHT has no use
  // for nine banks of macros, and an operator has no way to see which bank they
  // are in.
  (p.controls ?? []).slice(0, APC_COLS).forEach((control, i) => {
    for (let bank = 0; bank <= 8; bank++) {
      add('cc', bank, 0x10 + i, { kind: 'control', controlId: control.id });
    }
  });
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
  const sync = project.sync;

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
