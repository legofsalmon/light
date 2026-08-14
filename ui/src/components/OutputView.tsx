import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { NumInput, ScrubNumInput, UnicastInput } from './inputs.tsx';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';

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
  const data = useStore((s) => s.snap?.dmx[universeId]);
  const project = useStore((s) => s.project)!;
  const [hover, setHover] = useState<number | null>(null);
  const spans = useMemo(() => spansFor(project, universeId), [project, universeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = METER_W;
    canvas.height = METER_H;
    ctx.fillStyle = '#1a1a1c';
    ctx.fillRect(0, 0, METER_W, METER_H);

    // --- fixture spans: alternating bands so a patch is readable at a glance
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.textBaseline = 'middle';
    spans.forEach((s, i) => {
      const x = (s.from - 1) * CH_W;
      const w = (s.to - s.from + 1) * CH_W;
      ctx.fillStyle = i % 2 ? '#2b2b31' : '#232329';
      ctx.fillRect(x, 0, w, RIBBON_H);
      ctx.fillStyle = '#3a3a42';
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
      ctx.fillStyle = overridden ? '#ffb020' : v > 0 ? '#39c2ff' : '#26262a';
      ctx.fillRect(i * CH_W, top + usable - h, 1.6, Math.max(1, h));
    }

    // --- hover marker
    if (hover !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect((hover - 1) * CH_W, 0, CH_W, METER_H - 9);
    }

    ctx.fillStyle = '#5c5c66';
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
    if (hover === null) return 'hover a channel to read it · click to load it into the override';
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
          onMouseMove={(e) => setHover(chAt(e))}
          onMouseLeave={() => setHover(null)}
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
          onMouseDown={() => send({ type: 'setChannel', universeId, channel, value: 255 })}
          onMouseUp={() => {
            const held = overrides[channel];
            send({ type: 'setChannel', universeId, channel, value: held ?? null });
          }}
          onMouseLeave={() => {
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
          >
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
        ? 'discovery unavailable — UDP 6454 is held by another app (QLC+? a second engine?)'
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

  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <div className="sectionhead">Universes</div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Label</th><th>Art-Net</th><th>ArtNet uni</th><th>sACN</th><th>sACN uni</th>
              <th>Destination</th><th>Fixtures</th><th></th>
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
                    <input className="text" style={{ width: 140 }} value={u.label} onChange={(e) => editU((x) => (x.label = e.target.value))} />
                  </td>
                  <td>
                    <button className={`btn small ${u.artnet ? 'on' : ''}`} onClick={() => editU((x) => (x.artnet = !x.artnet))}>
                      {u.artnet ? 'on' : 'off'}
                    </button>
                  </td>
                  <td>
                    <NumInput
                      value={u.artnetUniverse}
                      min={0}
                      max={32767}
                      onCommit={(v) => editU((x) => (x.artnetUniverse = v))}
                    />
                  </td>
                  <td>
                    <button className={`btn small ${u.sacn ? 'on' : ''}`} onClick={() => editU((x) => (x.sacn = !x.sacn))}>
                      {u.sacn ? 'on' : 'off'}
                    </button>
                  </td>
                  <td>
                    <NumInput
                      value={u.sacnUniverse}
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
              artnet: true,
              sacn: false,
              unicast: null,
            });
          })}
        >
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
          <select className="sel" value={meterUniverse} onChange={(e) => setMeterU(e.target.value)}>
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
    </div>
  );
}
