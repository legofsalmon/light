// Riding a whole look live: four dials in the editor's header that offset
// every part of it at once (design A41, #44, Lightkey's modifiers).
//
// They are not a new kind of state. Each one fans out over the SAME soft nudge
// path the faders below already send — one `soft` command per address — so
// what a dial does is counted by the held chip, written in by Keep and thrown
// away by Discard exactly as a nudge is, and nothing it does can reach the
// stored show until Keep is pressed. Nothing new in either engine.
//
// The arithmetic and the address lists live in offsets.ts beside this, where
// they can be tested without a screen. This is the row.

import React, { useEffect, useMemo, useRef } from 'react';
import type { Look } from '../../../../shared/types.ts';
import { Fader } from '../Fader.tsx';
import { useStore } from '../../store.ts';
import { useEditorStore } from '../../editorStore.ts';
import { OFFSET_DIALS, OFFSET_NEUTRAL, type OffsetAddress, type OffsetDial, offsetTakers } from './offsets.ts';
import '../../styles/offsets.css';

export function OffsetDials({ lookId, look }: { lookId: string; look: Look }): React.ReactElement | null {
  const project = useStore((s) => s.project)!;
  const send = useStore((s) => s.send);
  const rideCutAt = useStore((s) => s.rideCutAt);
  const soft = useStore((s) => s.snap?.soft);
  const offsets = useEditorStore((s) => s.offsets[lookId]);
  const setOffset = useEditorStore((s) => s.setOffset);
  const clearOffsets = useEditorStore((s) => s.clearOffsets);

  const takers = useMemo(() => offsetTakers(project, look), [project, look]);

  /** The dials read neutral again the moment the look has no nudges left on
   *  it — which is what Keep, Discard and ALL STOP all do — so their positions
   *  are derived from the rig rather than remembered against it. Watched as a
   *  transition, not as a state: between a dial's send and the engine's echo
   *  there are no entries yet, and reading the steady state would snap the
   *  dial back out from under the finger. */
  const seen = useRef<{ id: string; on: boolean }>({ id: lookId, on: false });
  const riding = !!soft?.some((e) => e.lookId === lookId);
  useEffect(() => {
    const s = seen.current;
    if (s.id !== lookId) {
      seen.current = { id: lookId, on: riding };
      return;
    }
    if (riding) s.on = true;
    else if (s.on) {
      s.on = false;
      clearOffsets(lookId);
    }
  }, [riding, lookId, clearOffsets]);

  const apply = (dial: OffsetDial, v: number, addresses: OffsetAddress[]): void => {
    // the same window PartEditor drops in: a drag still in flight must not put
    // back the nudges ALL STOP has just cleared
    if (Date.now() - rideCutAt < 800) return;
    setOffset(lookId, dial, v);
    const spec = OFFSET_DIALS.find((d) => d.dial === dial);
    if (!spec) return;
    const neutral = v === OFFSET_NEUTRAL[dial];
    for (const a of addresses) {
      send({
        type: 'soft',
        lookId,
        partId: a.partId,
        effectId: a.effectId,
        field: a.field,
        // at neutral the dial is doing nothing, so it holds nothing: its
        // addresses are released and stop being counted as held
        value: neutral ? null : spec.at(a.base, v),
      });
    }
  };

  // Every dial dark means a look with no colour, no level, no aim and no
  // effects — an empty part. There is nothing to offer, so the row is absent
  // rather than four dead faders.
  if (OFFSET_DIALS.every((d) => takers[d.dial].length === 0)) return null;
  return (
    <div className="offsetrow" role="group" aria-label="offsets for the whole look">
      <span className="label">offset</span>
      {OFFSET_DIALS.map((d) => {
        const addresses = takers[d.dial];
        const off = addresses.length === 0;
        const v = off ? OFFSET_NEUTRAL[d.dial] : offsets?.[d.dial] ?? OFFSET_NEUTRAL[d.dial];
        return (
          <div className={`offsetdial ${off ? 'off' : ''}`} key={d.dial}>
            <Fader
              label={d.label}
              // wide enough for the longest caption beside the longest reading
              // (`dimmer 1.00×`): a dial whose number is clipped is a dial you
              // cannot set from across the booth
              width={96}
              variant="dim"
              min={d.min}
              max={d.max}
              def={OFFSET_NEUTRAL[d.dial]}
              value={v}
              fmt={d.fmt}
              help={off ? d.empty : d.help}
              onChange={(x) => apply(d.dial, x, addresses)}
            />
            {v !== OFFSET_NEUTRAL[d.dial] && <i className="offsetmark" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}
