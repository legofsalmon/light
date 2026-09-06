import React, { useEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { LookEditor } from './LookEditor.tsx';

/** The look editor as a column of the pads view.
 *
 *  The same component the bottom panel's Look tab renders — one editor, two
 *  homes — so that building the next song does not mean leaving the surface you
 *  perform from. It follows the grid selection like the tab does, which is what
 *  makes "click a pad's name, edit it, drag it somewhere else" one gesture
 *  chain instead of a view switch each way.
 */
export function EditorPane() {
  const setEditorHidden = useStore((s) => s.setEditorHidden);
  const sel = useStore((s) => s.sel);
  const ride = useStore((s) => s.ride);
  const bodyRef = useRef<HTMLDivElement>(null);
  // a new selection starts at the top — otherwise the next look opens
  // pre-scrolled to wherever the last one was left
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [sel?.layerId, sel?.col]);

  return (
    <>
      <div className="previzbar">
        <button
          className="btn small ghost pin"
          title="hide the look editor — the pad grid takes the width"
          onClick={() => setEditorHidden(true)}
        >
          ▸
        </button>
        <span className="label">look editor</span>
        {ride && <span className="label" style={{ color: 'var(--warn)' }}>nudging</span>}
      </div>
      <div className="editorbody" ref={bodyRef}>
        <LookEditor />
      </div>
    </>
  );
}
