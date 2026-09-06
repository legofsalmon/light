import React, { useState } from 'react';
import { useStore } from '../store.ts';
import { gridLayout, ringLayout, stripLayout, type HeadPlacement } from '../layouts.ts';

/** Pixel-layout editor (B1): a ten-second parametric Strip / Grid / Ring for
 *  imported multi-head profiles whose GDTF carried no usable geometry. The
 *  layout is written onto the PROFILE's heads, so one apply lays out every
 *  fixture of that type — and files that DID carry real geometry arrive
 *  already laid out by the importer, no editor needed. */
export function PixelLayout(): React.ReactElement | null {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const multi = Object.entries(project.profiles ?? {}).filter(([, p]) => p.heads.length > 1);
  const [sel, setSel] = useState<string>('');
  const [kind, setKind] = useState<'strip' | 'grid' | 'ring'>('strip');
  const [pitch, setPitch] = useState(0.05);
  const [cols, setCols] = useState(8);
  const [pitchY, setPitchY] = useState(0.05);
  const [serpentine, setSerpentine] = useState(true);
  const [diameter, setDiameter] = useState(0.2);
  const [startDeg, setStartDeg] = useState(0);

  if (multi.length === 0) return null;
  const active = multi.find(([id]) => id === sel) ?? null;
  const n = active ? active[1].heads.length : 0;

  const placements: HeadPlacement[] = !active
    ? []
    : kind === 'strip'
      ? stripLayout(n, pitch)
      : kind === 'grid'
        ? gridLayout(n, cols, pitch, pitchY, serpentine)
        : ringLayout(n, diameter, startDeg);

  // preview scale: fit the layout into a 160×90 box
  const span = placements.reduce((m, p) => Math.max(m, Math.abs(p.offset), Math.abs(p.offsetY)), 0.01);
  const scale = 42 / span;

  const num = (v: number, set: (x: number) => void, step: number, min: number, title: string) => (
    <input
      className="num"
      type="number"
      step={step}
      min={min}
      style={{ width: 62 }}
      title={title}
      value={v}
      onChange={(e) => {
        const x = Number(e.target.value);
        if (Number.isFinite(x) && x >= min) set(x);
      }}
    />
  );

  return (
    <div style={{ marginTop: 14 }}>
      <div className="sectionhead">Pixel layout — imported multi-head profiles</div>
      <div className="label" style={{ marginBottom: 6 }}>
        Lay out one profile’s pixels and every fixture of that type follows. Files that carry real
        geometry are laid out automatically on import; this is for the ones that don’t.
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <select className="sel" title="which multi-pixel profile to lay out — every fixture using it inherits the result" value={sel} onChange={(e) => setSel(e.target.value)}>
              <option value="">choose profile…</option>
              {multi.map(([id, p]) => (
                <option key={id} value={id}>
                  {p.model} · {p.heads.length}px
                </option>
              ))}
            </select>
            {active && (
              <div className="seg">
                {(['strip', 'grid', 'ring'] as const).map((k) => (
                  <button
                    key={k}
                    className={kind === k ? 'on' : ''}
                    title={
                      k === 'strip'
                        ? 'one straight run of pixels'
                        : k === 'grid'
                          ? 'rows and columns, wired serpentine — what a matrix panel actually is'
                          : 'pixels evenly around a circle, like a Spiider ring'
                    }
                    onClick={() => setKind(k)}
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
          </div>
          {active && kind === 'strip' && (
            <div className="row">
              <span className="label">pitch m</span>
              {num(pitch, setPitch, 0.01, 0.001, 'centre-to-centre spacing along the bar')}
            </div>
          )}
          {active && kind === 'grid' && (
            <div className="row">
              <span className="label">cols</span>
              {num(cols, setCols, 1, 1, 'pixels per row')}
              <span className="label">pitch m</span>
              {num(pitch, setPitch, 0.01, 0.001, 'horizontal spacing')}
              <span className="label">×</span>
              {num(pitchY, setPitchY, 0.01, 0.001, 'vertical spacing')}
              <button
                className={`btn small ${serpentine ? 'on' : 'ghost'}`}
                title="odd rows run right-to-left — pixel strings are usually wired as a snake"
                onClick={() => setSerpentine(!serpentine)}
              >
                serpentine
              </button>
            </div>
          )}
          {active && kind === 'ring' && (
            <div className="row">
              <span className="label">⌀ m</span>
              {num(diameter, setDiameter, 0.01, 0.001, 'ring diameter')}
              <span className="label">start °</span>
              {num(startDeg, setStartDeg, 5, -360, 'where pixel 1 sits, clockwise from 12 o’clock')}
            </div>
          )}
          {active && (
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="btn small"
                title="write this layout onto the profile — every fixture using it inherits the pixel positions, which is what row/col spreads and the stage read"
                onClick={() =>
                  mutate((p) => {
                    const prof = p.profiles?.[active[0]];
                    if (!prof) return;
                    prof.heads = prof.heads.map((h, i) => ({
                      ...h,
                      offset: placements[i]?.offset ?? h.offset,
                      offsetY: placements[i]?.offsetY ?? 0,
                      row: placements[i]?.row ?? 0,
                      col: placements[i]?.col ?? i,
                    }));
                  })
                }
              >
                apply to “{active[1].model}”
              </button>
            </div>
          )}
        </div>
        {active && (
          <svg
            width={200}
            height={110}
            style={{ background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 4, flexShrink: 0 }}
          >
            {placements.map((p, i) => (
              <circle
                key={i}
                cx={100 + p.offset * scale}
                cy={55 - p.offsetY * scale}
                r={3}
                fill={`hsl(${(i * 360) / n}, 80%, 60%)`}
              >
                <title>{`px ${i + 1} · row ${p.row} col ${p.col}`}</title>
              </circle>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
