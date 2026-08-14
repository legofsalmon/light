import React, { useEffect, useRef } from 'react';
import type { Layer, LayerSnap } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { askChoice, askConfirm, askPrompt } from '../dialog.tsx';
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
  // hasOwn, not a bare index: a cell holding "constructor" or "toString"
  // resolves to a function off the prototype and renders as a phantom look
  const look = lookId && Object.hasOwn(project.looks, lookId) ? project.looks[lookId] : null;
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

function LayerHead({ layer, live }: { layer: Layer; live: LayerSnap | undefined }) {
  const send = useStore((s) => s.send);
  const project = useStore((s) => s.project)!;
  // The grid scrolls and looks fire from MIDI/OSC too, so the active cell can
  // be off-screen. The layer head never scrolls — it is the one place that can
  // always answer "what is this layer doing right now".
  const liveId = live?.lookId ?? null;
  const liveLook = liveId && Object.hasOwn(project.looks, liveId) ? project.looks[liveId] : null;
  const crossfading = !!liveLook && (live?.t ?? 1) < 1;
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
      <div
        className={`nowplaying ${liveLook ? 'on' : ''} ${crossfading ? 'fading' : ''}`}
        title={
          liveLook
            ? `playing: ${liveLook.name}${live?.col != null ? ` (column ${live.col + 1})` : ''}`
            : 'nothing playing on this layer'
        }
      >
        {liveLook ? (
          <>
            <span className="swatch mini">
              {lookSwatch(liveLook, project.looks).map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
            <span className="grow ellip">{liveLook.name}</span>
          </>
        ) : (
          '—'
        )}
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
          {decks.length > 1 && d.id === project.activeDeckId && (
            <>
              <span
                className="deckmove"
                title="move this song earlier"
                onClick={(e) => {
                  e.stopPropagation();
                  mutate((p) => {
                    const arr = p.decks ?? [];
                    const i = arr.findIndex((x) => x.id === d.id);
                    if (i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
                  });
                }}
              >
                ‹
              </span>
              <span
                className="deckmove"
                title="move this song later"
                onClick={(e) => {
                  e.stopPropagation();
                  mutate((p) => {
                    const arr = p.decks ?? [];
                    const i = arr.findIndex((x) => x.id === d.id);
                    if (i >= 0 && i < arr.length - 1) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
                  });
                }}
              >
                ›
              </span>
            </>
          )}
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
      {decks.length > 1 && (() => {
        const i = decks.findIndex((x) => x.id === project.activeDeckId);
        const next = decks[((i < 0 ? 0 : i) + 1) % decks.length];
        return (
          <span className="decknext" title="what ] / the APC bank ▶ will select next">
            next: {next.name}
          </span>
        );
      })()}
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
  const mutate = useStore((s) => s.mutate);

  const cols = project.columns;
  const layers = [...project.layers].reverse(); // top of stack first

  /** Column edits touch three places that must stay the same length: the live
   *  columns, every layer's cells, and the active deck's stored copy of both.
   *  The engine only syncs the deck when you switch away, so doing it here
   *  keeps a saved show consistent even if you never leave the song. */
  const editColumns = (fn: (cols: string[], cellsOf: (layerId: string) => (string | null)[]) => void) =>
    mutate((p) => {
      const cellArrays = new Map(p.layers.map((l) => [l.id, l.cells]));
      fn(p.columns, (id) => cellArrays.get(id)!);
      const deck = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
      if (deck) {
        deck.columns = [...p.columns];
        deck.cells = Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]]));
      }
    });

  const renameColumn = (col: number) => {
    void askPrompt(`Rename column ${col + 1}`, cols[col] ?? '', {
      body: 'Column names are per song — naming them after the song’s sections is the point.',
      confirmLabel: 'Rename',
    }).then((name) => {
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      editColumns((c) => {
        c[col] = trimmed;
      });
    });
  };

  const insertColumn = (after: number) => {
    editColumns((c, cellsOf) => {
      c.splice(after + 1, 0, `Col ${c.length + 1}`);
      for (const l of layers) cellsOf(l.id).splice(after + 1, 0, null);
    });
  };

  const deleteColumn = (col: number) => {
    const filled = layers.filter((l) => l.cells[col]).length;
    void askConfirm(`Delete column ${col + 1}${cols[col] ? ` · ${cols[col]}` : ''}?`, {
      body:
        filled > 0
          ? `${filled} cell(s) in this column will be removed from this song. The looks themselves stay in the pool.`
          : 'The column is empty.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      editColumns((c, cellsOf) => {
        c.splice(col, 1);
        for (const l of layers) cellsOf(l.id).splice(col, 1);
      });
    });
  };

  return (
    <>
    <DeckBar />
    <div
      className="lookgrid"
      style={{ gridTemplateColumns: `168px repeat(${cols.length}, 108px) 30px` }}
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
          title={`trigger column ${col + 1} (key ${col + 1}) · right-click to rename, insert or delete`}
          onClick={() => {
            if (!useStore.getState().armLearn({ kind: 'column', col })) send({ type: 'column', col });
          }}
          // right-click, never left: a left click fires the column, so editing
          // must not be reachable by the gesture that triggers cues
          onContextMenu={(e) => {
            e.preventDefault();
            void askChoice(`Column ${col + 1}${name ? ` · ${name}` : ''}`, [
              { value: 'rename', label: 'Rename…', primary: true },
              { value: 'insert', label: 'Insert column after' },
              ...(cols.length > 1
                ? [{ value: 'delete', label: 'Delete column', danger: true }]
                : []),
            ]).then((choice) => {
              if (choice === 'rename') renameColumn(col);
              else if (choice === 'insert') insertColumn(col);
              else if (choice === 'delete') deleteColumn(col);
            });
          }}
        >
          {col + 1} · {name}
        </div>
      ))}
      <div
        className="colhead addcol"
        title="add a column to this song"
        onClick={() => insertColumn(cols.length - 1)}
      >
        +
      </div>
      {layers.map((layer) => {
        const live = liveLayers?.find((l) => l.id === layer.id);
        return (
          <React.Fragment key={layer.id}>
            <LayerHead layer={layer} live={live} />
            {cols.map((_, col) => (
              <Cell key={col} layer={layer} col={col} live={live} />
            ))}
            {/* grid auto-flow is continuous, so every row must fill the
                add-column track or the next layer head slides up into it */}
            <div className="gridfiller" />
          </React.Fragment>
        );
      })}
    </div>
    </>
  );
}
