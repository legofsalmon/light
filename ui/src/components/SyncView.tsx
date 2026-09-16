// Sync · MIDI (design 2.10). The section opens as one line —
// `APC40 mk2 · 52 mappings · learn` — with the mechanism prose behind ? and
// the mapping table behind a disclosure. Fifty-two rows of note numbers is a
// reference, not a screen: the question this section actually answers on a
// show day is "is my controller on", and that is the summary line.

import React, { useMemo, useState } from 'react';
import { Glyph } from '../glyphs.tsx';
import { create } from 'zustand';
import type { MidiMapping, Project } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { NumInput } from './inputs.tsx';
import { CONTROLLER_PRESETS, controllerPreset, type ControllerPresetName } from '../controllerPresets.ts';
import { describeMidiAction, describeMidiSource } from '../labels.ts';
import '../styles/setup.css';

/** A mapping without its id: what makes two layouts the same layout. */
const signature = (m: MidiMapping[]): string =>
  m
    .map((x) => `${x.type}:${x.channel}:${x.number}:${JSON.stringify(x.action)}`)
    .sort()
    .join('|');

/** Which layout is loaded, if any — the summary line's first word. Computed by
 *  rebuilding each preset against THIS show, because a preset's mapping depends
 *  on the show's own layers and columns. */
export function loadedPreset(p: Project): string | null {
  if (p.midi.length === 0) return null;
  const have = signature(p.midi);
  return CONTROLLER_PRESETS.find((preset) => signature(preset.build(p)) === have)?.label ?? null;
}

// --- loading a layout, and the way back --------------------------------------
// The old flow asked "this replaces all current MIDI mappings" and then did it.
// A confirm before an action that is trivially undoable is a click that teaches
// nothing; a chip afterwards is the honest shape, and it is the only shape that
// works when the DIALS head fires this in one gesture from its controller menu.
type PresetUndo = { label: string; project: string; before: MidiMapping[] };
const useUndo = create<{ undo: PresetUndo | null; set: (u: PresetUndo | null) => void }>()((set) => ({
  undo: null,
  set: (undo) => set({ undo }),
}));

/** Load a controller layout in place. No dialog: the chip is the way back. */
export function loadControllerPreset(name: ControllerPresetName): void {
  const preset = controllerPreset(name);
  const st = useStore.getState();
  const project = st.project;
  if (!preset || !project) return;
  const before = structuredClone(project.midi);
  st.mutate((p) => {
    p.midi = preset.build(p);
  }, `load the ${preset.label} layout`);
  useUndo.getState().set({ label: preset.label, project: project.name, before });
}

/** The chip that puts the old mappings back. Rendered once, wherever the setup
 *  surface is mounted, so a load fired from the DIALS head still leaves a way
 *  out. It goes away on undo, on dismiss, and on a different show. */
export function PresetUndoChip(): React.ReactElement | null {
  const undo = useUndo((s) => s.undo);
  const projectName = useStore((s) => s.project?.name);
  if (!undo || undo.project !== projectName) return null;
  const count = undo.before.length;
  return (
    <div className="undochip" role="status">
      <span className="label">{undo.label} loaded</span>
      <button
        className="btn small"
        title={count === 0 ? 'put the mappings back the way they were: there were none' : `put the ${count} mappings that were here back`}
        onClick={() => {
          useStore.getState().mutate((p) => {
            p.midi = structuredClone(undo.before);
          }, 'undo the controller layout');
          useUndo.getState().set(null);
        }}
      >
        undo
      </button>
      <button className="btn small ghost" title="keep the layout and put this away" onClick={() => useUndo.getState().set(null)}>
        <Glyph name="clear" alone />
      </button>
    </div>
  );
}

/** The one line the section opens as, with the two things behind it. */
function MidiSummary(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const learnMode = useStore((s) => s.learnMode);
  const toggleLearnMode = useStore((s) => s.toggleLearnMode);
  const mutate = useStore((s) => s.mutate);
  const lastMidi = useStore((s) => s.lastMidi);
  const midiInputs = useStore((s) => s.midiInputs);
  const snap = useStore((s) => s.snap);
  const [why, setWhy] = useState(false);
  const [table, setTable] = useState(false);
  const [pick, setPick] = useState(false);
  // Naming the layout means rebuilding every preset against this show and
  // comparing; cheap, but not something to redo on every fader frame that
  // lands a new project.
  const preset = useMemo(() => loadedPreset(project), [project]);
  const n = project.midi.length;

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="label">{preset ?? (n === 0 ? 'no layout' : 'own layout')}</span>
        <span className="label">·</span>
        <span className="label">{n === 1 ? '1 mapping' : `${n} mappings`}</span>
        <button
          className={`btn small ${learnMode ? 'on' : ''}`}
          title="arm learn, then click a pad, column or fader here and touch the control on your device. The pair is named back to you when it binds."
          onClick={toggleLearnMode}
        >
          learn
        </button>
        <button
          className="btn small ghost"
          aria-expanded={why}
          title="how the Resolume link, the beat clock and learn actually work"
          onClick={() => setWhy(!why)}
        >
          ?
        </button>
        <div className="grow" />
        <span className="label" style={{ fontFamily: 'var(--text-value-family)' }}>{lastMidi ?? ''}</span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="label">inputs</span>
        {midiInputs.length === 0 ? (
          <span className="label" style={{ color: 'var(--text-faint)' }}>none detected (browser needs MIDI permission)</span>
        ) : (
          midiInputs.map((name) => (
            <span key={name} className="chip" title={`${name} — an input LIGHT is listening on`}>{name}</span>
          ))
        )}
      </div>
      {learnMode && (
        <div className="prose">Learn is armed — click a pad, column or fader, then press or move the control on your device.</div>
      )}
      {why && (
        <>
          <div className="prose">
            Learn binds one control at a time: arm it, click the thing on this screen, then touch the
            thing on the device. A layout below does the same job for a whole controller at once, and
            replaces every mapping — with the way back offered rather than asked for.
          </div>
          {snap?.midiPort && (
            <div className="prose">
              A DAW on this Mac needs no bus of its own. LIGHT publishes a MIDI port called <b>{snap.midiPort}</b>{' '}
              while it is running, so it is already in the DAW's list of MIDI outputs — point a track at
              it and learn a pad from a note. Beat clock sent there drives the tempo too. It is a
              destination, not an input, which is why it is not listed above.
            </div>
          )}
        </>
      )}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="btn small"
          aria-expanded={pick}
          title="load a whole controller layout at once — hover one for the map it will lay down"
          onClick={() => setPick(!pick)}
        >
          <Glyph name="chevron" className={pick ? '' : 'shut'} /> load a layout
        </button>
        <button
          className="btn small ghost"
          aria-expanded={table}
          title={n === 0 ? 'nothing is mapped yet' : 'every mapping, source and target'}
          onClick={() => setTable(!table)}
        >
          <Glyph name="chevron" className={table ? '' : 'shut'} /> mappings
        </button>
      </div>
      {pick && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {CONTROLLER_PRESETS.map((c) => (
            <button
              key={c.name}
              className="btn small"
              title={c.help}
              onClick={() => {
                setPick(false);
                loadControllerPreset(c.name);
              }}
            >
              {c.label}
            </button>
          ))}
          <span className="prose">Loads in place. The chip that follows puts the old mappings back.</span>
        </div>
      )}
      {table && (
        <table className="tbl">
          <thead>
            <tr><th>Source</th><th>Target</th><th></th></tr>
          </thead>
          <tbody>
            {project.midi.map((m) => (
              <tr key={m.id}>
                <td className="mono">{describeMidiSource(m)}</td>
                <td>{describeMidiAction(project, m.action)}</td>
                <td>
                  <button
                    title="delete this MIDI mapping"
                    className="btn small ghost"
                    onClick={() => mutate((p) => {
                      p.midi = p.midi.filter((x) => x.id !== m.id);
                    })}
                  >
                    <Glyph name="clear" alone />
                  </button>
                </td>
              </tr>
            ))}
            {n === 0 && (
              <tr><td colSpan={3} style={{ color: 'var(--text-faint)' }}>no mappings yet</td></tr>
            )}
          </tbody>
        </table>
      )}
    </>
  );
}

export function SyncView() {
  const project = useStore((s) => s.project)!;
  const oscLog = useStore((s) => s.oscLog);
  const mutate = useStore((s) => s.mutate);
  const send = useStore((s) => s.send);
  const snap = useStore((s) => s.snap);
  const sync = project.sync;
  const clock = snap?.midiClock;
  const clockSource = clock?.on ? clock.source : undefined;
  const [arena, setArena] = useState(false);

  const editSync = (fn: (s: typeof sync) => void) => mutate((p) => fn(p.sync));

  return (
    <div className="col" style={{ gap: 'var(--space-8)' }}>
      <div className="sectionhead">MIDI</div>
      <MidiSummary />

      <div className="sectionhead">Resolume link</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
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
        <button
          className="btn small ghost"
          aria-expanded={arena}
          title="what to switch on in Arena, and what LIGHT listens for"
          onClick={() => setArena(!arena)}
        >
          ?
        </button>
      </div>
      {arena && (
        <div className="prose">
          Arena ▸ Preferences ▸ OSC → enable <b>OSC Output</b>, address <b>127.0.0.1</b>, port <b>{sync.oscPort}</b>.
          Column launches then fire the matching column here, and Arena's BPM drives all effects.
          Extra addresses: /light/bpm (float) · /light/column (int, 1-based) · /light/blackout (0/1).
        </div>
      )}
      <div className="oscmon">
        {oscLog.length === 0 && <span style={{ color: 'var(--text-faint)' }}>waiting for Arena…</span>}
        {oscLog.map((e, i) => (
          <div key={`${e.t}-${i}`}>
            <span className="addr">{e.addr}</span> <span className="args">{e.args.map((a) => (typeof a === 'number' ? +a.toFixed(4) : a)).join(' ')}</span>
          </div>
        ))}
      </div>

      <div className="sectionhead">Beat clock</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
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
    </div>
  );
}
