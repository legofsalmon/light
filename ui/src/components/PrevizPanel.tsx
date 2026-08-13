import React from 'react';
import { useStore } from '../store.ts';
import { Fader } from './Fader.tsx';
import { Previz2D } from './Previz2D.tsx';
import { Previz3D } from './Previz3D.tsx';

export function PrevizPanel() {
  const mode = useStore((s) => s.previzMode);
  const setMode = useStore((s) => s.setPrevizMode);
  const hazeViz = useStore((s) => s.hazeViz);
  const setHazeViz = useStore((s) => s.setHazeViz);

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
        {mode === '2d' && <span className="label">drag fixtures to place them</span>}
      </div>
      <div className="previzview">{mode === '3d' ? <Previz3D /> : <Previz2D />}</div>
    </>
  );
}
