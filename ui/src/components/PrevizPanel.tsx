import React from 'react';
import { createGroupFromSelection } from '../selection.ts';
import { useStore } from '../store.ts';
import { Fader } from './Fader.tsx';
import { Previz2D } from './Previz2D.tsx';
import { Previz3D } from './Previz3D.tsx';

export function PrevizPanel() {
  const mode = useStore((s) => s.previzMode);
  const setMode = useStore((s) => s.setPrevizMode);
  const view2d = useStore((s) => s.previz2dView);
  const setView2d = useStore((s) => s.setPreviz2dView);
  const hazeViz = useStore((s) => s.hazeViz);
  const setHazeViz = useStore((s) => s.setHazeViz);
  const fxSel = useStore((s) => s.fxSel);

  return (
    <>
      <div className="previzbar">
        <span className="label">previz</span>
        <div className="seg">
          <button className={mode === '3d' ? 'on' : ''} onClick={() => setMode('3d')}>3D</button>
          <button className={mode === '2d' ? 'on' : ''} onClick={() => setMode('2d')}>2D plan</button>
        </div>
        <div className="grow" />
        {mode === '3d' && (
          <Fader label="beam viz" width={110} value={hazeViz} onChange={setHazeViz} def={0.7} variant="dim" />
        )}
        {mode === '2d' && (
          <>
            {fxSel.length > 0 && (
              <button className="btn" onClick={createGroupFromSelection} title="Create a group from the selected fixtures (appears in the Fixtures tab)">
                ⊕ group from {fxSel.length} selected
              </button>
            )}
            <div className="seg">
              <button className={view2d === 'plan' ? 'on' : ''} onClick={() => setView2d('plan')}>Plan</button>
              <button className={view2d === 'front' ? 'on' : ''} onClick={() => setView2d('front')}>Front</button>
            </div>
            <span className="label">
              {view2d === 'plan'
                ? 'drag to place · ⌥-drag rotate · ⇧-click / drag-box select'
                : 'drag to set height · ⇧-click / drag-box select'}
            </span>
          </>
        )}
      </div>
      <div className="previzview">{mode === '3d' ? <Previz3D /> : <Previz2D />}</div>
    </>
  );
}
