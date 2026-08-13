import React from 'react';
import type { Layer, LayerSnap } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { Fader } from './Fader.tsx';
import { lookSwatch } from '../lookColors.ts';

function Cell({ layer, col, live }: { layer: Layer; col: number; live: LayerSnap | undefined }) {
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);
  const learnMode = useStore((s) => s.learnMode);
  const learnTarget = useStore((s) => s.learnTarget);
  const send = useStore((s) => s.send);
  const setSel = useStore((s) => s.setSel);

  const lookId = layer.cells[col] ?? null;
  const look = lookId ? project.looks[lookId] : null;
  const active = !!lookId && live?.lookId === lookId && live?.col === col;
  const fading = active && (live?.t ?? 1) < 1;
  const selected = sel?.layerId === layer.id && sel?.col === col;
  const armed =
    !!learnTarget && learnTarget.kind === 'cell' && learnTarget.layerId === layer.id && learnTarget.col === col;

  return (
    <div
      className={`cell ${look ? '' : 'empty'} ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${armed ? 'learn-armed' : ''}`}
      onPointerDown={(e) => {
        setSel({ layerId: layer.id, col });
        if (learnMode) {
          useStore.getState().armLearn({ kind: 'cell', layerId: layer.id, col });
          return;
        }
        if (!look) return;
        send({ type: 'trigger', layerId: layer.id, col });
        if (look.flash) {
          e.currentTarget.setPointerCapture(e.pointerId);
        }
      }}
      onPointerUp={() => {
        if (!learnMode && look?.flash) send({ type: 'release', layerId: layer.id, col });
      }}
      onPointerCancel={() => {
        if (!learnMode && look?.flash) send({ type: 'release', layerId: layer.id, col });
      }}
    >
      {look && (
        <>
          <div className="swatch">
            {lookSwatch(look).map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </div>
          {look.flash && <div className="flashmark">FLASH</div>}
          <div className="cellname">{look.name}</div>
          {fading && <div className="fadebar" style={{ width: `${(live?.t ?? 0) * 100}%` }} />}
        </>
      )}
    </div>
  );
}

function LayerHead({ layer }: { layer: Layer }) {
  const send = useStore((s) => s.send);
  return (
    <div className="layerhead">
      <div className="row">
        <div className="name grow">{layer.name}</div>
        <span className="chip">{layer.blend}</span>
        <button
          className="btn small ghost"
          title="clear layer"
          onClick={() => {
            if (!useStore.getState().armLearn({ kind: 'layerClear', layerId: layer.id })) {
              send({ type: 'clearLayer', layerId: layer.id });
            }
          }}
        >
          ✕
        </button>
      </div>
      <Fader
        value={layer.master}
        onChange={(v) => send({ type: 'setLayerMaster', layerId: layer.id, v })}
        def={1}
        variant="dim"
        learn={{ kind: 'layerMaster', layerId: layer.id }}
      />
    </div>
  );
}

export function LookGrid() {
  const project = useStore((s) => s.project)!;
  const liveLayers = useStore((s) => s.snap?.layers);
  const learnMode = useStore((s) => s.learnMode);
  const learnTarget = useStore((s) => s.learnTarget);
  const send = useStore((s) => s.send);

  const cols = project.columns;
  const layers = [...project.layers].reverse(); // top of stack first

  return (
    <div
      className="lookgrid"
      style={{ gridTemplateColumns: `168px repeat(${cols.length}, 108px)` }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        className="label"
      >
        {learnMode ? (learnTarget ? 'move a control…' : 'click a target…') : ''}
      </div>
      {cols.map((name, col) => (
        <div
          key={col}
          className={`colhead ${learnTarget?.kind === 'column' && learnTarget.col === col ? 'learn-armed' : ''}`}
          title={`trigger column ${col + 1} (key ${col + 1})`}
          onClick={() => {
            if (!useStore.getState().armLearn({ kind: 'column', col })) send({ type: 'column', col });
          }}
        >
          {col + 1} · {name}
        </div>
      ))}
      {layers.map((layer) => {
        const live = liveLayers?.find((l) => l.id === layer.id);
        return (
          <React.Fragment key={layer.id}>
            <LayerHead layer={layer} />
            {cols.map((_, col) => (
              <Cell key={col} layer={layer} col={col} live={live} />
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}
