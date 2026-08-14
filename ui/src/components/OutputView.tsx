import React, { useEffect, useRef, useState } from 'react';
import { uid } from '../../../shared/types.ts';
import { NumInput, UnicastInput } from './inputs.tsx';
import { useStore } from '../store.ts';

function DmxMeters({ universeId }: { universeId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = useStore((s) => s.snap?.dmx[universeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = 1024;
    const H = 64;
    canvas.width = W;
    canvas.height = H;
    ctx.fillStyle = '#1a1a1c';
    ctx.fillRect(0, 0, W, H);
    if (!data) return;
    for (let i = 0; i < 512; i++) {
      const v = data[i] ?? 0;
      const h = (v / 255) * (H - 10);
      ctx.fillStyle = v > 0 ? '#39c2ff' : '#26262a';
      ctx.fillRect(i * 2, H - 8 - h, 1.6, Math.max(1, h));
    }
    ctx.fillStyle = '#5c5c66';
    ctx.font = '8px ui-monospace';
    for (let c = 0; c <= 512; c += 64) {
      ctx.fillText(String(c === 0 ? 1 : c), Math.min(c, 508) * 2, H - 1);
    }
  }, [data]);

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 3 }}>
      <canvas ref={canvasRef} style={{ display: 'block', height: 64 }} />
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

export function OutputView() {
  const project = useStore((s) => s.project)!;
  const stats = useStore((s) => s.snap?.stats);
  const mutate = useStore((s) => s.mutate);
  const [meterU, setMeterU] = useState(project.universes[0]?.id ?? '');
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
        <DmxMeters universeId={meterUniverse} />
      </div>
    </div>
  );
}
