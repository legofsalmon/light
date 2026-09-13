// One look, as a tile (design 2.7, #29).
//
// The old library was 190 rows of text with a `×N` that counted one song, so
// the two questions you actually ask it — "which of these two Ashes is the one
// on the derbies" and "is anything still using this" — both needed the look
// opened. A tile answers them without being opened: the face says which of the
// rig it touches, the marks say how it behaves, the kinds say what it drives,
// and the count is every pad in every song.

import React from 'react';
import { contextPress } from '../../touch.ts';
import { KIND_LABEL } from '../../labels.ts';
import type { LibraryEntry } from './model.ts';
import { Bolt, Chain } from './marks.tsx';
import { Face } from './face.tsx';

/** The two drag payloads, spelled as LookGrid spells them: the look, and the
 *  song the drag began in so a song switch mid-drag cannot redirect the drop. */
const LOOK_DRAG = 'application/x-light-look';
const DECK_DRAG = 'application/x-light-deck';

export function LookTile({
  entry,
  twin,
  armed,
  revealed,
  deckId,
  touch,
  onArm,
  onMenu,
}: {
  entry: LibraryEntry;
  /** another look in the pool has this name, so the group is worth printing */
  twin: boolean;
  armed: boolean;
  /** find, or the library's own "show me this one", put a ring on it */
  revealed: boolean;
  deckId: string;
  touch: boolean;
  onArm: () => void;
  onMenu: (at: { x: number; y: number }) => void;
}) {
  const { look, face, kinds, pads, songs, orphan, onStage } = entry;
  const steps = look.steps?.length ?? 0;
  const ref = React.useRef<HTMLDivElement>(null);
  // The menu opens under the tile rather than at the pointer, because a hold
  // has no pointer position the finger has not already covered.
  const menu = contextPress(() => {
    const r = ref.current?.getBoundingClientRect();
    onMenu({ x: r ? r.left : 0, y: r ? r.bottom : 0 });
  });

  const use = pads === 0
    ? 'on no pad in any song'
    : `on ${pads} pad${pads === 1 ? '' : 's'} across ${songs} song${songs === 1 ? '' : 's'}`;
  const what = [
    look.flash ? 'holds only while the pad is held' : '',
    steps ? `plays ${steps} looks in order` : '',
    kinds.map((k) => KIND_LABEL[k]).join(', '),
  ].filter(Boolean).join(' · ');

  return (
    <div
      ref={ref}
      className={`libtile ${armed ? 'armed' : ''} ${revealed ? 'selected' : ''} ${orphan ? 'orphan' : ''} ${onStage ? 'live' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={armed}
      draggable
      title={
        orphan
          ? `${look.name} — none of its groups are in this rig, so it would light nothing. ${use}.`
          : `${look.name}${twin && entry.group ? ` · ${entry.group}` : ''} — ${use}. ${what ? `${what}. ` : ''}${
              touch ? 'Tap' : 'Click'
            } to arm it, then ${touch ? 'tap' : 'click'} a pad's name; or drag it onto a pad.`
      }
      onClick={onArm}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onArm();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(LOOK_DRAG, look.id);
        e.dataTransfer.setData(DECK_DRAG, deckId);
        e.dataTransfer.effectAllowed = 'copy';
        // hand the keyboard back to the show before the drop lands
        (document.activeElement as HTMLElement | null)?.blur();
      }}
      {...menu}
    >
      <Face face={face} />
      {look.flash && <span className="corner bolt"><Bolt /></span>}
      {steps > 0 && (
        <span className="corner chain">
          <Chain />
          <b>{steps}</b>
        </span>
      )}
      <div className="tilename">
        {look.name}
        {twin && entry.group && <span className="of"> · {entry.group}</span>}
      </div>
      <div className="tilefoot">
        <span className="kinds">{kinds.join('')}</span>
        <span className="grow" />
        <span className="count">{pads === 0 ? 'unused' : `×${pads} · ${songs}`}</span>
      </div>
    </div>
  );
}
