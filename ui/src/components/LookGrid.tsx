import React, { useEffect, useRef } from 'react';
import type { Layer, LayerSnap } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { askConfirm, askPrompt } from '../dialog.tsx';
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
        if (e.button !== 0) return; // right/middle-click must never latch a flash look
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
            {lookSwatch(look, project.looks).map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </div>
          {look.flash && <div className="flashmark">FLASH</div>}
          <div className="cellname">{look.steps?.length ? '⛓ ' : ''}{look.name}</div>
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
          className="btn small ghost clearbtn"
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

function DeckBar() {
  const project = useStore((s) => s.project)!;
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const decks = project.decks ?? [];
  const activeChipRef = useRef<HTMLDivElement>(null);
  // a deck change from the APC bank arrows (or [ / ]) must bring the live
  // song on screen — with 12 songs the active chip is often scrolled away
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [project.activeDeckId]);
  if (decks.length === 0) return null;

  return (
    <div className="deckbar">
      <span className="label">deck</span>
      <button
        className="btn small ghost"
        title="previous song ( [ )"
        disabled={decks.length < 2}
        onClick={() => {
          const i = decks.findIndex((x) => x.id === project.activeDeckId);
          const n = decks.length;
          send({ type: 'switchDeck', deckId: decks[((i < 0 ? 0 : i) - 1 + n) % n].id });
        }}
      >
        ◀
      </button>
      <button
        className="btn small ghost"
        title="next song ( ] )"
        disabled={decks.length < 2}
        onClick={() => {
          const i = decks.findIndex((x) => x.id === project.activeDeckId);
          const n = decks.length;
          send({ type: 'switchDeck', deckId: decks[((i < 0 ? 0 : i) + 1) % n].id });
        }}
      >
        ▶
      </button>
      {decks.map((d) => (
        <div
          key={d.id}
          ref={d.id === project.activeDeckId ? activeChipRef : undefined}
          className={`deckchip ${d.id === project.activeDeckId ? 'on' : ''}`}
          title="click to switch · double-click to rename"
          onClick={() => send({ type: 'switchDeck', deckId: d.id })}
          onDoubleClick={() => {
            void (async () => {
              const name = await askPrompt('Rename deck', d.name);
              if (!name) return;
              mutate((p) => {
                const dk = p.decks?.find((x) => x.id === d.id);
                if (dk) dk.name = name;
              });
            })();
          }}
        >
          {d.name}
          {decks.length > 1 && d.id !== project.activeDeckId && (
            <span
              className="deckx"
              title="delete deck"
              onClick={(e) => {
                e.stopPropagation();
                void (async () => {
                  const ok = await askConfirm(`Delete deck "${d.name}"?`, {
                    body: 'Its cell layout is lost. The looks themselves are kept in the pool.',
                    confirmLabel: 'Delete deck',
                    danger: true,
                  });
                  if (!ok) return;
                  mutate((p) => {
                    p.decks = (p.decks ?? []).filter((x) => x.id !== d.id);
                  });
                })();
              }}
            >
              ×
            </span>
          )}
        </div>
      ))}
      <button
        className="btn small ghost"
        title="new empty deck"
        onClick={() => {
          const id = uid('deck');
          mutate((p) => {
            p.decks ??= [];
            p.decks.push({ id, name: `Song ${p.decks.length + 1}`, columns: [...p.columns], cells: {} });
          });
          send({ type: 'switchDeck', deckId: id }); // land on the deck you just made
        }}
      >
        + deck
      </button>
      <button
        className="btn small ghost"
        title="copy the current deck's cells into a new deck — the usual way to start the next song"
        onClick={() => {
          const id = uid('deck');
          mutate((p) => {
            p.decks ??= [];
            const src = p.decks.find((d) => d.id === p.activeDeckId);
            p.decks.push({
              id,
              name: `${src?.name ?? 'Song'} copy`,
              columns: [...p.columns],
              // the live layer cells ARE the active deck — copy those
              cells: Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]])),
            });
          });
          send({ type: 'switchDeck', deckId: id });
        }}
      >
        ⧉ duplicate
      </button>
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
    <>
    <DeckBar />
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
    </>
  );
}
