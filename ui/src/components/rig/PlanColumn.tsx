// The plan, as a column beside the table (design 2.9) — its own 2D view, not
// the stage band borrowed from under a live rig. Under it, the aim strip: point
// what is selected at someone on the plan and store that as its base aim.

import React, { useEffect, useMemo } from 'react';
import { aimAtPoint, aimTargets } from '../../rig.ts';
import { profileMeta } from '../../profileInfo.ts';
import { useRig } from '../../rigStore.ts';
import { useStore } from '../../store.ts';
import { Previz2D } from '../Previz2D.tsx';
import { FindButton } from './parts.tsx';

export function PlanColumn(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const view2d = useStore((s) => s.previz2dView);
  const setView2d = useStore((s) => s.setPreviz2dView);
  const tool = useStore((s) => s.previz2dTool);
  const setTool = useStore((s) => s.setPreviz2dTool);
  const snapToTruss = useStore((s) => s.snapToTruss);
  const setSnapToTruss = useStore((s) => s.setSnapToTruss);
  const showMeasure = useStore((s) => s.showMeasure);
  const setShowMeasure = useStore((s) => s.setShowMeasure);
  const prefix = useRig((s) => s.prefix);
  const setPrefix = useRig((s) => s.setPrefix);

  /** Type-to-select (A43): a typed prefix picks the fixtures whose names start
   *  with it, ⌃Tab steps one at a time, Esc clears.
   *
   *  Every key it takes is stopped here. The window handler under it fires
   *  cues on 1–9 and blackout on B, and a rig page where typing a fixture's
   *  name blacks the room out is exactly the misfire class this design
   *  forbids — so the plan has to have focus for any of this to happen, and
   *  what it consumes never reaches anything else. */
  const matches = useMemo(() => {
    const q = prefix.trim().toLowerCase();
    if (!q) return [];
    return project.fixtures.filter((f) => f.name.toLowerCase().startsWith(q));
  }, [project, prefix]);

  const onPlanKey = (e: React.KeyboardEvent) => {
    const st = useRig.getState();
    if (e.key === 'Escape') {
      if (!st.prefix && useStore.getState().fxSel.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setPrefix('');
      useStore.getState().setFxSel([]);
      return;
    }
    if (e.key === 'Tab' && e.ctrlKey) {
      if (matches.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const next = (st.step + 1) % matches.length;
      setPrefix(st.prefix, next);
      useStore.getState().setFxSel([matches[next].id]);
      return;
    }
    if (e.key === 'Backspace') {
      if (!st.prefix) return;
      e.preventDefault();
      e.stopPropagation();
      const p = st.prefix.slice(0, -1);
      setPrefix(p);
      const q = p.trim().toLowerCase();
      useStore.getState().setFxSel(
        q ? project.fixtures.filter((f) => f.name.toLowerCase().startsWith(q)).map((f) => f.id) : [],
      );
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const p = st.prefix + e.key;
    setPrefix(p);
    const q = p.trim().toLowerCase();
    useStore.getState().setFxSel(project.fixtures.filter((f) => f.name.toLowerCase().startsWith(q)).map((f) => f.id));
  };

  // A prefix left on screen after the selection has moved on is a lie about
  // what is selected; clearing it when the plan loses focus keeps the chip
  // honest without a timer nobody can see.
  useEffect(() => () => setPrefix(''), [setPrefix]);

  return (
    <div className="rigplan">
      <div className="rigplanbar">
        <div className="seg">
          <button
            className={view2d === 'plan' ? 'on' : ''}
            title="top-down: dragging a fixture sets where it stands on the floor"
            onClick={() => setView2d('plan')}
          >
            Plan
          </button>
          <button
            className={view2d === 'front' ? 'on' : ''}
            title="front elevation: dragging a fixture sets its hang height, not its position"
            onClick={() => setView2d('front')}
          >
            Front
          </button>
        </div>
        <div className="seg" role="group" aria-label="plan tool">
          <button
            className={tool === 'move' || (tool === 'rotate' && view2d !== 'plan') ? 'on' : ''}
            title={view2d === 'plan'
              ? 'drag moves a fixture or a structure; a drag on empty space boxes a selection'
              : 'drag sets a fixture’s hang height; a drag on empty space boxes a selection'}
            onClick={() => setTool('move')}
          >
            Move
          </button>
          {view2d === 'plan' && (
            <button
              className={tool === 'rotate' ? 'on' : ''}
              title="drag turns a fixture or a bar (snaps to 5°). ⌥-drag does the same with a mouse."
              onClick={() => setTool('rotate')}
            >
              Turn
            </button>
          )}
          <button
            className={tool === 'select' ? 'on' : ''}
            title="click adds a fixture to the selection or takes it out; a drag on empty space adds everything in the box. ⇧-click does the same with a mouse."
            onClick={() => setTool('select')}
          >
            Select
          </button>
        </div>
        <button
          className={`btn small ${snapToTruss ? 'on' : 'ghost'}`}
          title="dragging a fixture near a truss bar clamps it on and rigs it there"
          onClick={() => setSnapToTruss(!snapToTruss)}
        >
          snap
        </button>
        <button
          className={`btn small ${showMeasure ? 'on' : 'ghost'}`}
          title="metre grid and dimensions — for placing structure and judging scale"
          onClick={() => setShowMeasure(!showMeasure)}
        >
          measure
        </button>
        {prefix && (
          <span
            className="rigchip"
            title="typed at the plan: it selects every fixture whose name starts with this. ⌃Tab steps through them, Esc clears."
            onClick={() => { setPrefix(''); useStore.getState().setFxSel([]); }}
          >
            {prefix} · {matches.length}
          </span>
        )}
      </div>
      <div
        className="rigplanview"
        tabIndex={0}
        role="group"
        aria-label="stage plan"
        title="drag to place · ⌥-drag turns · ⇧-click or drag a box selects · type a name to select"
        onKeyDown={onPlanKey}
      >
        <Previz2D />
      </div>
      <AimStrip />
    </div>
  );
}

/** The aim strip: where the selected heads are pointed, and the one press that
 *  stores it.
 *
 *  The arithmetic is the inverse of `shared/aim.ts` done in the UI (design
 *  2.9): the show file gains nothing new, every engine renders it exactly as it
 *  rendered a hand-typed base aim, and an operator who moves a musician two
 *  metres re-aims eight heads in one press instead of scrubbing sixteen
 *  numbers. */
function AimStrip(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const fxSel = useStore((s) => s.fxSel);
  const aimAt = useRig((s) => s.aimAt);
  const setAimAt = useRig((s) => s.setAimAt);
  const jumpTo = useRig((s) => s.jumpTo);
  const identified = useStore((s) => s.snap?.identify) ?? null;

  const targets = useMemo(() => aimTargets(project), [project]);
  const target = targets.find((t) => t.id === aimAt) ?? null;
  const movers = fxSel.filter((id) => {
    const f = project.fixtures.find((x) => x.id === id);
    const meta = f && profileMeta(project, f.profileId);
    return !!meta && (meta.hasPan || meta.hasTilt);
  });
  const solutions = useMemo(
    () => (target ? movers.map((id) => ({ id, sol: aimAtPoint(project, id, target.point) })) : []),
    [project, movers, target],
  );
  const short = solutions.filter((s) => s.sol && !s.sol.reach).length;

  const store = () => {
    if (!target || solutions.length === 0) return;
    mutate((p) => {
      for (const { id, sol } of solutions) {
        const f = p.fixtures.find((x) => x.id === id);
        const meta = f && profileMeta(p, f.profileId);
        if (!f || !meta || !sol) continue;
        // 50 % is centre and centre is the default, so a head that lands there
        // keeps the field absent rather than storing an explicit 0.5.
        if (meta.hasPan) {
          if (Math.abs(sol.pan - 0.5) < 1e-6) delete f.pan;
          else f.pan = sol.pan;
        }
        if (meta.hasTilt) {
          if (Math.abs(sol.tilt - 0.5) < 1e-6) delete f.tilt;
          else f.tilt = sol.tilt;
        }
      }
    }, `aim ${solutions.length === 1 ? 'a fixture' : `${solutions.length} fixtures`} at the ${target.label}`);
  };

  if (targets.length === 0) {
    return (
      <div className="rigaim">
        <div className="rigempty">
          aim at ▾ — add a musician or a truss on the plan
          <button className="btn small ghost" title="the Stage section, where musicians and structures are added" onClick={() => jumpTo('stage')}>
            Stage
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rigaim">
      <div className="aimrow">
        <span className="label">aim</span>
        <span className="prose">
          {movers.length === 0
            ? fxSel.length === 0 ? 'nothing selected' : 'nothing selected can aim'
            : `${movers.length} selected`}
        </span>
      </div>
      <div className="aimrow">
        <select
          className="sel"
          value={aimAt ?? ''}
          title="what on the plan these heads should point at"
          onChange={(e) => setAimAt(e.target.value || null)}
        >
          <option value="">aim at…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <button
          className="btn small"
          disabled={!target || solutions.length === 0}
          title="work out where each selected head has to point to land on that, and store it as its base aim. Looks keep moving relative to it."
          onClick={store}
        >
          store as base aim
        </button>
        {movers.length > 0 && (
          <FindButton fixtureId={movers[0]} on={identified === movers[0]} />
        )}
      </div>
      {short > 0 && (
        <span className="label" style={{ color: 'var(--warn)' }}>
          {short} of them cannot swing that far — their limits hold them as close as they reach
        </span>
      )}
    </div>
  );
}
