import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { NumInput, ScrubNumInput, TextField, UnicastInput } from './inputs.tsx';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';
import { color } from '../tokens.ts';

const METER_W = 1024;
const METER_H = 88;
const CH_W = METER_W / 512; // 2 px per channel
const RIBBON_H = 15; // fixture-span band across the top

type Span = { name: string; from: number; to: number; names: string[] };

/** Which fixture owns which channel, for the selected universe. */
function spansFor(project: Project, universeId: string): Span[] {
  return project.fixtures
    .filter((f) => f.universeId === universeId)
    .map((f) => {
      const meta = profileMeta(project, f.profileId);
      const width = meta?.channels ?? 1;
      return {
        name: f.name,
        from: f.address, // 1-based
        to: Math.min(512, f.address + width - 1),
        names: meta?.channelNames ?? [],
      };
    })
    .filter((s) => s.from >= 1 && s.from <= 512)
    .sort((a, b) => a.from - b.from);
}

/** ch is 1-based. Returns e.g. "Partybar 1 · Head 2 Green". */
function describeChannel(spans: Span[], ch: number): string | null {
  const s = spans.find((x) => ch >= x.from && ch <= x.to);
  if (!s) return null;
  const name = s.names[ch - s.from];
  return name && name !== '—' ? `${s.name} · ${name}` : s.name;
}

/** The transmit gate, stated where an operator comes to look for it.
 *
 *  LIGHT boots offline every time — see engine/output.ts for why — so there is
 *  always one deliberate step between opening a show and driving somebody's
 *  rig. The top bar carries the same control; this says it in full sentences,
 *  next to the universes it is gating, and doubles as the empty state for a
 *  show with no output set up at all. */
function TransmitBanner() {
  const project = useStore((s) => s.project)!;
  const send = useStore((s) => s.send);
  const live = useStore((s) => s.snap?.transmit) === true;
  const configured = project.universes.some((u) => u.artnet || u.sacn);

  if (!configured) {
    return (
      <div className="row" style={{ gap: 8 }}>
        <span className="label" style={{ color: 'var(--warn)' }}>⚠</span>
        <span className="prose">
          No universe is set up to send, so nothing can reach the rig. Turn on Art-Net or
          sACN below for the universes your nodes are listening to, then go live.
        </span>
      </div>
    );
  }
  return (
    <div className="row" style={{ gap: 8 }}>
      <button
        className={`btn ${live ? 'on' : 'warn on'}`}
        title={live ? 'stop sending — LIGHT blacks the rig out first' : 'start sending on every universe switched on below'}
        onClick={() => send({ type: 'setTransmit', v: !live })}
      >
        {live ? 'go offline' : 'go live'}
      </button>
      <span className="prose">
        {live
          ? 'Live — the universes switched on below are being sent. Going offline blacks the rig out first, then stops transmitting; the show keeps running on screen.'
          : 'Offline — nothing is leaving this Mac. LIGHT starts this way every time it opens, so a show can never drive a rig until you say so.'}
      </span>
    </div>
  );
}

function DmxMeters({
  universeId,
  overrides,
  onPick,
}: {
  universeId: string;
  overrides: Record<number, number>;
  onPick: (ch: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = useStore((s) => s.dmx[universeId]);
  const project = useStore((s) => s.project)!;
  const [hover, setHover] = useState<number | null>(null);
  const touch = useStore((s) => s.touch);
  const spans = useMemo(() => spansFor(project, universeId), [project, universeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = METER_W;
    canvas.height = METER_H;
    ctx.fillStyle = color['scene/meter-bg'];
    ctx.fillRect(0, 0, METER_W, METER_H);

    // --- fixture spans: alternating bands so a patch is readable at a glance
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.textBaseline = 'middle';
    spans.forEach((s, i) => {
      const x = (s.from - 1) * CH_W;
      const w = (s.to - s.from + 1) * CH_W;
      ctx.fillStyle = i % 2 ? color['scene/meter-span'] : color['scene/meter-span-2'];
      ctx.fillRect(x, 0, w, RIBBON_H);
      ctx.fillStyle = color['scene/meter-span-edge'];
      ctx.fillRect(x, RIBBON_H, Math.max(1, w), 1);
      // the label only fits on wide spans; the hover readout covers the rest
      if (w > 30) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 2, 0, w - 4, RIBBON_H);
        ctx.clip();
        ctx.fillStyle = '#9a9aa6';
        ctx.fillText(s.name, x + 3, RIBBON_H / 2);
        ctx.restore();
      }
    });

    // --- levels
    const top = RIBBON_H + 3;
    const usable = METER_H - top - 10;
    for (let i = 0; i < 512; i++) {
      const v = data?.[i] ?? 0;
      const h = (v / 255) * usable;
      const overridden = overrides[i + 1] !== undefined;
      ctx.fillStyle = overridden ? color['amber/400'] : v > 0 ? color['cyan/500'] : '#26262a';
      ctx.fillRect(i * CH_W, top + usable - h, 1.6, Math.max(1, h));
    }

    // --- hover marker
    if (hover !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect((hover - 1) * CH_W, 0, CH_W, METER_H - 9);
    }

    ctx.fillStyle = color['grey/400'];
    ctx.font = '8px ui-monospace';
    ctx.textBaseline = 'alphabetic';
    for (let c = 0; c <= 512; c += 64) {
      ctx.fillText(String(c === 0 ? 1 : c), Math.min(c, 508) * CH_W, METER_H - 1);
    }
  }, [data, spans, overrides, hover]);

  // the canvas is drawn at 1024 but can be scaled by its container
  const chAt = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0) return null;
    const ch = Math.floor((((e.clientX - r.left) / r.width) * METER_W) / CH_W) + 1;
    return ch >= 1 && ch <= 512 ? ch : null;
  };

  const readout = (() => {
    if (hover === null) return touch ? 'tap a channel to read it and load it into the override' : 'hover a channel to read it · click to load it into the override';
    const v = data?.[hover - 1] ?? 0;
    const who = describeChannel(spans, hover) ?? 'unpatched';
    const ov = overrides[hover];
    return `ch ${hover} · ${who} · ${v}${ov !== undefined ? `  (overridden to ${ov})` : ''}`;
  })();

  return (
    <div className="col" style={{ gap: 4 }}>
      <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 3 }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', height: METER_H, cursor: 'crosshair' }}
          // pointer, not mouse: a finger reads the meter too, and a lifted
          // finger keeps its reading — on glass there is nothing to hover
          onPointerMove={(e) => setHover(chAt(e))}
          onPointerDown={(e) => setHover(chAt(e))}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null); }}
          onClick={(e) => {
            const ch = chAt(e);
            if (ch !== null) onPick(ch);
          }}
        />
      </div>
      <span className="label mono" style={{ fontSize: 11 }}>{readout}</span>
    </div>
  );
}

/** Raw channel check: drive one wire channel to prove a fixture, cable or
 *  address before the doors open. Not saved — it is a meter, not show data. */
function ChannelCheck({
  universeId,
  overrides,
  setOverrides,
  pick,
}: {
  universeId: string;
  overrides: Record<number, number>;
  setOverrides: (fn: (o: Record<number, number>) => Record<number, number>) => void;
  pick: number;
}) {
  const send = useStore((s) => s.send);
  const engineCount = useStore((s) => s.snap?.overrides) ?? 0;
  const project = useStore((s) => s.project)!;
  const [channel, setChannel] = useState(pick);
  const [value, setValue] = useState(255);
  const spans = useMemo(() => spansFor(project, universeId), [project, universeId]);

  // clicking the monitor loads that channel here
  useEffect(() => setChannel(pick), [pick]);

  const set = (ch: number, v: number | null) => {
    send({ type: 'setChannel', universeId, channel: ch, value: v });
    setOverrides((o) => {
      const next = { ...o };
      if (v === null) delete next[ch];
      else next[ch] = v;
      return next;
    });
  };

  const local = Object.keys(overrides).length;
  const who = describeChannel(spans, channel);

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="label">channel</span>
        <ScrubNumInput
          value={channel}
          scrubStep={0.5}
          decimals={0}
          width={64}
          title="DMX channel 1-512 — drag to scan the universe"
          onSet={(v) => setChannel(Math.max(1, Math.min(512, Math.round(v))))}
          onDelta={(d) => setChannel((c) => Math.max(1, Math.min(512, Math.round(c + d))))}
        />
        <span className="label">value</span>
        <ScrubNumInput
          value={value}
          scrubStep={1}
          decimals={0}
          width={64}
          title="0-255"
          onSet={(v) => {
            const n = Math.max(0, Math.min(255, Math.round(v)));
            setValue(n);
            if (overrides[channel] !== undefined) set(channel, n);
          }}
          onDelta={(d) => setValue((x) => {
            const n = Math.max(0, Math.min(255, Math.round(x + d)));
            if (overrides[channel] !== undefined) set(channel, n);
            return n;
          })}
        />
        <input
          type="range"
          title="scrub this channel's level — takes effect only while the channel is overridden"
          min={0}
          max={255}
          value={value}
          style={{ width: 160 }}
          onChange={(e) => {
            const n = Number(e.target.value);
            setValue(n);
            if (overrides[channel] !== undefined) set(channel, n);
          }}
        />
        <button
          className={`btn small ${overrides[channel] !== undefined ? 'on' : ''}`}
          title="hold this channel at the value above, overriding the show"
          onClick={() => set(channel, overrides[channel] !== undefined ? null : value)}
        >
          {overrides[channel] !== undefined ? 'release' : 'hold'}
        </button>
        <button
          className="btn small ghost"
          title="flash the channel to full while held down"
          // Pointer events, not mouse events. Touch browsers synthesise the
          // mouse pair as a burst AFTER the tap, so on the FOH tablet the flash
          // came and went inside one frame and the channel never visibly moved
          // — reading as a dead fixture during a channel check, which is the
          // one job this control exists for. Every other press-and-hold in the
          // app (flash pads, faders) is already pointer-based.
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            send({ type: 'setChannel', universeId, channel, value: 255 });
          }}
          onPointerUp={() => {
            const held = overrides[channel];
            send({ type: 'setChannel', universeId, channel, value: held ?? null });
          }}
          onPointerCancel={() => {
            const held = overrides[channel];
            send({ type: 'setChannel', universeId, channel, value: held ?? null });
          }}
        >
          bump
        </button>
        <span className="label">{who ?? 'unpatched channel'}</span>
      </div>
      {(local > 0 || engineCount > 0) && (
        <div className="row" style={{ gap: 10 }}>
          <span className="warnchip">
            {Math.max(local, engineCount)} channel override{Math.max(local, engineCount) === 1 ? '' : 's'} held
            — the show is not driving {Math.max(local, engineCount) === 1 ? 'it' : 'them'}
          </span>
          <button
            className="btn small"
            onClick={() => {
              send({ type: 'clearChannelOverrides' });
              setOverrides(() => ({}));
            }}
          
            title="let go of every held channel — the show drives them all again">
            release all
          </button>
        </div>
      )}
    </div>
  );
}

function PollStatusLine({ artnetOn }: { artnetOn: boolean }) {
  const nodes = useStore((s) => s.snap?.artnetNodes);
  const poll = useStore((s) => s.snap?.artnetPoll);
  if (nodes?.length) return null;
  return (
    <span className="label">
      {poll === 'failed'
        ? 'discovery unavailable — port 6454 is held by another app (QLC+? a second engine?)'
        : artnetOn
          ? 'polling… no nodes have answered yet — check network / node power'
          : 'Art-Net output is off on every universe'}
    </span>
  );
}

function NodeList() {
  const nodes = useStore((s) => s.snap?.artnetNodes);
  if (!nodes?.length) return null;
  return (
    <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
      {nodes.map((n) => {
        const fresh = n.ageMs < 8000;
        return (
          <span key={n.ip} className="label" style={{ color: fresh ? 'var(--good)' : 'var(--warn)' }}>
            ● {n.name} <span style={{ fontFamily: 'var(--mono)' }}>{n.ip}</span>
            {fresh ? '' : ` (silent ${Math.round(n.ageMs / 1000)}s)`}
          </span>
        );
      })}
    </div>
  );
}

const EMPTY: Record<number, number> = {};

export function OutputView() {
  const project = useStore((s) => s.project)!;
  const stats = useStore((s) => s.snap?.stats);
  const mutate = useStore((s) => s.mutate);
  const engineOverrides = useStore((s) => s.snap?.overrides) ?? 0;
  const [meterU, setMeterU] = useState(project.universes[0]?.id ?? '');
  // Overrides are transient engine state; the snapshot only carries the count,
  // so the UI mirrors what it set and drops the mirror whenever the engine says
  // it holds none (all-stop, release-all, or a restart cleared them).
  const [overrides, setOverrides] = useState<Record<string, Record<number, number>>>({});
  const [pick, setPick] = useState(1);
  useEffect(() => {
    if (engineOverrides === 0) {
      setOverrides((o) => (Object.keys(o).length === 0 ? o : {}));
    }
  }, [engineOverrides]);
  // a universe delete or project switch can strand the selection on a dead id
  const meterUniverse = project.universes.some((u) => u.id === meterU)
    ? meterU
    : project.universes[0]?.id ?? '';
  useEffect(() => {
    if (meterUniverse !== meterU) setMeterU(meterUniverse);
  }, [meterUniverse, meterU]);

  // Raw DMX is opt-in per client: this tab is the only thing that reads it, and
  // only one universe at a time. Subscribing here (and unsubscribing on the way
  // out) is what keeps ~8 KB a frame off every other client — the previz, the
  // FOH tablet — that never looks at a byte of it.
  const send = useStore((s) => s.send);
  useEffect(() => {
    if (!meterUniverse) return;
    send({ type: 'watchDmx', universeIds: [meterUniverse] });
    return () => send({ type: 'watchDmx', universeIds: [] });
  }, [meterUniverse, send]);

  return (
    <div className="col" style={{ gap: 14 }}>
      <TransmitBanner />
      <div>
        <div className="sectionhead">Universes</div>
        <table className="tbl">
          <thead>
            <tr>
              <th title="a universe is one DMX line of 512 channels">Universe</th><th>Art-Net</th><th>Art-Net universe</th><th>sACN</th><th>sACN universe</th>
              <th title="where Art-Net packets go: everyone on the network, or one node's address">Send to</th><th>Fixtures</th><th></th>
            </tr>
          </thead>
          <tbody>
            {project.universes.map((u) => {
              const editU = (fn: (x: typeof u) => void) =>
                mutate((p) => {
                  const x = p.universes.find((y) => y.id === u.id);
                  if (x) fn(x);
                });
              const used = project.fixtures.filter((f) => f.universeId === u.id).length;
              return (
                <tr key={u.id}>
                  <td>
                    <TextField className="text" title="this universe's name — for your own reference; it is not sent anywhere. A universe is one DMX line of 512 channels." style={{ width: 140 }} entityId={u.id} value={u.label} onCommit={(v) => editU((x) => (x.label = v))} />
                  </td>
                  <td>
                    <button
                      className={`btn small ${u.artnet ? 'on' : ''}`}
                      title="send this universe over Art-Net. Off means the console runs normally and this universe reaches no fixtures."
                      onClick={() => editU((x) => (x.artnet = !x.artnet))}
                    >
                      {u.artnet ? 'on' : 'off'}
                    </button>
                  </td>
                  <td>
                    <NumInput
                      value={u.artnetUniverse}
                      title="Art-Net port-address (0–32767) this universe is sent on — must match what the node expects"
                      min={0}
                      max={32767}
                      onCommit={(v) => editU((x) => (x.artnetUniverse = v))}
                    />
                  </td>
                  <td>
                    <button
                      className={`btn small ${u.sacn ? 'on' : ''}`}
                      title="send this universe over sACN (E1.31). Art-Net and sACN can run at the same time."
                      onClick={() => editU((x) => (x.sacn = !x.sacn))}
                    >
                      {u.sacn ? 'on' : 'off'}
                    </button>
                  </td>
                  <td>
                    <NumInput
                      value={u.sacnUniverse}
                      title="sACN universe number (1–63999) this universe is sent on"
                      min={1}
                      max={63999}
                      onCommit={(v) => editU((x) => (x.sacnUniverse = v))}
                    />
                  </td>
                  <td>
                    <UnicastInput
                      value={u.unicast}
                      onCommit={(v) => editU((x) => (x.unicast = v))}
                    />
                  </td>
                  <td className="mono">{used}</td>
                  <td>
                    <button
                      className="btn small ghost"
                      disabled={used > 0 || project.universes.length <= 1}
                      title={
                        used > 0
                          ? `${used} fixture(s) still patched here — move them first`
                          : project.universes.length <= 1
                            ? 'the last universe cannot be deleted'
                            : 'delete universe'
                      }
                      onClick={() => mutate((p) => {
                        p.universes = p.universes.filter((x) => x.id !== u.id);
                      })}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button
          className="btn small"
          style={{ marginTop: 8 }}
          onClick={() => mutate((p) => {
            const maxU = Math.max(0, ...p.universes.map((x) => x.artnetUniverse));
            p.universes.push({
              id: uid('u'),
              label: `Universe ${p.universes.length + 1}`,
              artnetUniverse: maxU + 1,
              sacnUniverse: maxU + 1,
              artnet: false,
              sacn: false,
              unicast: null,
            });
          })}
        
            title="another DMX universe: 512 channels with its own Art-Net/sACN destination — off until you turn it on">
          + add universe
        </button>
      </div>

      <div>
        <div className="sectionhead">Art-Net nodes</div>
        <PollStatusLine artnetOn={project.universes.some((u) => u.artnet)} />
        <NodeList />
      </div>

      <div>
        <div className="sectionhead">Engine</div>
        <div className="row" style={{ gap: 18 }}>
          <span className="label">refresh <b style={{ color: 'var(--text)' }}>{stats?.fps ?? '–'} Hz</b></span>
          <span className="label">jitter <b style={{ color: (stats?.jitter ?? 0) > 5 ? 'var(--warn)' : 'var(--text)' }}>{stats?.jitter ?? '–'} ms</b></span>
          <span className="label">art-net frames <b style={{ color: 'var(--text)' }}>{stats?.artnet ?? 0}</b></span>
          <span className="label">sacn frames <b style={{ color: 'var(--text)' }}>{stats?.sacn ?? 0}</b></span>
        </div>
      </div>

      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <div className="sectionhead" style={{ margin: 0, border: 'none', padding: 0 }}>DMX monitor</div>
          <select className="sel" title="which universe the channel meters below are showing" value={meterUniverse} onChange={(e) => setMeterU(e.target.value)}>
            {project.universes.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </select>
        </div>
        <DmxMeters
          universeId={meterUniverse}
          overrides={overrides[meterUniverse] ?? EMPTY}
          onPick={setPick}
        />
      </div>

      <div>
        <div className="sectionhead">Channel check</div>
        <ChannelCheck
          universeId={meterUniverse}
          overrides={overrides[meterUniverse] ?? EMPTY}
          setOverrides={(fn) =>
            setOverrides((all) => {
              const next = fn(all[meterUniverse] ?? EMPTY);
              return { ...all, [meterUniverse]: next };
            })
          }
          pick={pick}
        />
      </div>

      {/* Gated out here, not just inside the panel: the panel returns null
          without a Tauri bridge, but a bare sectionhead over nothing is what a
          browser and the LAN tablet were left looking at. */}
    </div>
  );
}
