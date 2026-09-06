// The setup path (backlog #1). Five surfaces have to be visited before a rig
// does anything — where the DMX goes, what is on the truss, how big the room
// is, what moves together, and where the movers point — and they were five
// unordered tabs with nothing saying they were a sequence or that you had
// finished one.
//
// It guides rather than hosts: each step sends you to the real surface, full
// size, and ticks itself off by READING the project rather than asking you to
// say you are done. A step you already satisfied — an imported MVR arrives with
// fixtures, groups and positions in one go — is ticked before you ever see it,
// which is the difference between a checklist and a wizard that makes you
// re-do work.
//
// It opens by itself when a project has no fixtures, which is exactly a new
// project and nothing else. A fresh install boots the demo show, and the demo
// needs no setting up — so a first launch is left alone to be played with.

import React, { useEffect, useState } from 'react';
import type { Project } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { profileMeta } from '../profileInfo.ts';

type Step = {
  id: string;
  title: string;
  blurb: string;
  /** satisfied, read off the project — never self-reported */
  done: (p: Project) => boolean;
  /** true when this rig cannot need the step at all */
  skip?: (p: Project) => boolean;
  /** where the work happens */
  go: () => void;
};

/** Does this rig have anything that can be aimed? */
function hasMovers(p: Project): boolean {
  return p.fixtures.some((f) => {
    const meta = profileMeta(p, f.profileId);
    return !!meta && (meta.hasPan || meta.hasTilt);
  });
}

/** Send the operator to a section of the Rig view and scroll it into sight. */
function toRig(section?: string): void {
  const st = useStore.getState();
  st.setView('patch');
  st.setTab('patch');
  if (!section) return;
  // after the tab has rendered
  requestAnimationFrame(() => {
    document.querySelector(`[data-setup="${section}"]`)?.scrollIntoView({ block: 'start' });
  });
}

const STEPS: Step[] = [
  {
    id: 'output',
    title: 'Output',
    blurb: 'Say where the DMX goes: switch on Art-Net or sACN for the universes your nodes are listening to.',
    done: (p) => p.universes.some((u) => u.artnet || u.sacn),
    go: () => {
      const st = useStore.getState();
      st.setView('patch');
      st.setTab('output');
    },
  },
  {
    id: 'fixtures',
    title: 'Fixtures',
    blurb: 'Patch what is actually on the truss, at the addresses it is set to. Import a GDTF for one fixture, or an MVR for the whole plot.',
    done: (p) => p.fixtures.length > 0,
    go: () => toRig('fixtures'),
  },
  {
    id: 'stage',
    title: 'Stage',
    blurb: 'Set the size of the room, then drag the fixtures on the plan to where they hang. This is what the stage view draws and what spread effects fan across.',
    done: (p) => p.stage !== undefined || p.fixtures.some((f) => f.pos.x !== 0 || f.pos.z !== 0),
    go: () => toRig('stage'),
  },
  {
    id: 'groups',
    title: 'Groups',
    blurb: 'Fixtures you will light together. Looks are built on groups, not on single fixtures, so nothing can be programmed until there is at least one.',
    done: (p) => p.groups.length > 0,
    go: () => toRig('groups'),
  },
  {
    id: 'aim',
    title: 'Aim',
    blurb: 'Point each moving head at the stage once, in the Fixtures table. Looks then move around that aim instead of from the centre of its travel.',
    done: (p) => p.fixtures.some((f) => f.pan !== undefined || f.tilt !== undefined),
    skip: (p) => !hasMovers(p),
    go: () => toRig('fixtures'),
  },
];

export function SetupGuide(): React.ReactElement | null {
  const project = useStore((s) => s.project);
  const open = useStore((s) => s.setupGuide);
  const dismissed = useStore((s) => s.setupDismissed);
  const setSetupGuide = useStore((s) => s.setSetupGuide);
  const live = useStore((s) => s.snap?.transmit) === true;
  const send = useStore((s) => s.send);
  // It sits over the bottom-right of the work area, which is where the tables
  // it sends you to are. Rolled up it is one line of progress and gets out of
  // the way without losing your place.
  const [rolled, setRolled] = useState(false);

  // A project with no fixtures is a new project and nothing else: the demo has
  // thirteen, and any real show has more.
  const bare = !!project && project.fixtures.length === 0;
  useEffect(() => {
    if (bare && !dismissed) setSetupGuide(true);
  }, [bare, dismissed, setSetupGuide]);

  if (!open || !project) return null;

  const steps = STEPS.filter((s) => !s.skip?.(project));
  const state = steps.map((s) => ({ step: s, done: s.done(project) }));
  const next = state.find((s) => !s.done);
  const left = state.filter((s) => !s.done).length;

  return (
    <div className="setupguide" role="dialog" aria-label="rig setup">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button
          className="btn small ghost"
          title={rolled ? 'show the steps again' : 'roll this up out of the way — it keeps your place'}
          aria-expanded={!rolled}
          onClick={() => setRolled(!rolled)}
        >
          {rolled ? '▸' : '▾'} set up your rig
        </button>
        <span className="label">{left === 0 ? 'all done' : `${left} of ${steps.length} to go`}</span>
        <button
          className="btn small ghost"
          title="close this — the show is yours to work on either way. Settings brings it back."
          onClick={() => setSetupGuide(false, true)}
        >
          ✕
        </button>
      </div>
      {!rolled && (
        <>
          <div className="setupsteps">
            {state.map(({ step, done }, i) => (
              <button
                key={step.id}
                className={`setupstep ${done ? 'done' : ''} ${step === next?.step ? 'next' : ''}`}
                title={step.blurb}
                onClick={step.go}
              >
                <span className="setupmark">{done ? '✓' : i + 1}</span>
                <span className="label">{step.title}</span>
              </button>
            ))}
          </div>
          {next ? (
            <>
              <div className="prose">{next.step.blurb}</div>
              <button className="btn" onClick={next.step.go}>take me there</button>
            </>
          ) : (
            <>
              <div className="prose">
                That is the whole setup. LIGHT is still offline, so nothing has reached the rig
                yet — going live starts sending on the universes you switched on.
              </div>
              <div className="row" style={{ gap: 8 }}>
                {!live && (
                  <button
                    className="btn warn on"
                    title="start sending on every universe switched on in the Output tab"
                    onClick={() => send({ type: 'setTransmit', v: true })}
                  >
                    go live
                  </button>
                )}
                <button className="btn ghost" onClick={() => setSetupGuide(false, true)}>
                  {live ? 'done' : 'later'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
