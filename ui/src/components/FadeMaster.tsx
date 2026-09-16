// The FADE master (design decision 3, A26 — MagicQ's busking rate master).
//
// A look's fade lives in the look, so making a wash land as a hit for one drop
// meant editing the look and editing it back after. This is one fader over
// every crossfade a layer starts from now on: at the bottom every pad, column
// and clear is a cut; in the middle every look fades the way it was written;
// at the top they take four times as long. The engine reads it when a
// crossfade starts, so moving it never bends one already running, and it is
// never saved, so a show always opens as programmed.
import React from 'react';
import { FADE_SCALE_MAX, fadeScaleAt } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { Fader } from './Fader.tsx';

/** The fader position that gives this multiplier: fadeScaleAt, inverted. */
const positionOf = (scale: number): number =>
  Math.sqrt(Math.min(FADE_SCALE_MAX, Math.max(0, scale)) / FADE_SCALE_MAX);

export function FadeMaster({ width }: { width?: number }): React.ReactElement {
  // an engine from before the master reports nothing, which is "as programmed"
  const scale = useStore((s) => s.snap?.fadeScale ?? 1);
  const send = useStore((s) => s.send);
  return (
    <Fader
      label="fade"
      width={width}
      min={0}
      max={1}
      def={0.5}
      value={positionOf(scale)}
      fmt={(p) => {
        const x = fadeScaleAt(p);
        return x === 0 ? 'cut' : `${x.toFixed(2)}×`;
      }}
      parse={positionOf}
      onChange={(p) => send({ type: 'setFadeScale', v: fadeScaleAt(p) })}
      help="fade master — how long every crossfade a pad, a column or a clear starts takes, against each look's own fade. The bottom is a cut, the middle is as programmed, the top is four times as long. A fade already running keeps its length. Not saved with the show"
      learn={{ kind: 'fadeScale' }}
      variant="dim"
    />
  );
}
