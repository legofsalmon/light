// The setup path (backlog #1, design #40). Five surfaces have to be visited
// before a rig does anything — where the DMX goes, what is on the truss, how
// big the room is, what moves together, and where the movers point — and they
// were five unordered tabs with nothing saying they were a sequence or that you
// had finished one.
//
// It guides rather than hosts: each step sends you to the real surface, full
// size, and ticks itself off by READING the project rather than asking you to
// say you are done. A step you already satisfied — an imported MVR arrives with
// fixtures, groups and positions in one go — is ticked before you ever see it,
// which is the difference between a checklist and a wizard that makes you
// re-do work.
//
// It is a STRIP, not a card. A card beside the work sat over the bottom right
// of the screen — which is where the tables it points at are, so the guide
// covered the thing it was asking you to look at, and rolling it up to see
// under it was a control the guide had to invent. One line, always the same
// height, docked above the surface it sends you into.
//
// It opens by itself when a project has no fixtures, which is exactly a new
// project and nothing else. A fresh install boots the demo show, and the demo
// needs no setting up — so a first launch is left alone to be played with.

import React, { useEffect } from 'react';
import { Glyph } from '../glyphs.tsx';
import type { Project } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { profileMeta } from '../profileInfo.ts';
import { openSetup } from './AdminModal.tsx';
import '../styles/setup.css';

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

/** Jump to a section of the Rig page. The anchors are the rail's own sections
 *  (design 2.9): while the rail is being built this still scrolls the marked
 *  block into view, which is the same destination by a slower route. */
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
    // Output is a setup-surface section now, not a tab on the Rig page.
    go: () => openSetup('output'),
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
    <div className="guidestrip" role="group" aria-label="rig setup">
      <span className="label">set up your rig</span>
      <div className="guidesteps">
        {state.map(({ step, done }, i) => (
          <button
            key={step.id}
            className={`btn small ghost ${done ? 'done' : ''} ${step === next?.step ? 'next' : ''}`}
            title={`${step.blurb}${done ? ' — done: this is read off the show, not something you tick.' : ''}`}
            onClick={step.go}
          >
            {done ? '✓' : i + 1} {step.title}
          </button>
        ))}
      </div>
      <span className="label">{left === 0 ? 'all done' : `${left} to go`}</span>
      {next ? (
        <>
          <span className="prose" title={next.step.blurb}>{next.step.blurb}</span>
          <div className="grow" />
          <button className="btn small" onClick={next.step.go}>take me there</button>
        </>
      ) : (
        <>
          <span className="prose">
            That is the whole setup. LIGHT is still offline, so nothing has reached the rig yet.
          </span>
          <div className="grow" />
          {!live && (
            <button
              className="btn small warn on"
              title="start sending on every universe switched on in Output — the rig lights when this is pressed"
              onClick={() => send({ type: 'setTransmit', v: true })}
            >
              go live
            </button>
          )}
        </>
      )}
      <button
        className="btn small ghost"
        title="close this — the show is yours to work on either way. Setup ▸ Help brings it back."
        onClick={() => setSetupGuide(false, true)}
      >
        <Glyph name="clear" alone />
      </button>
    </div>
  );
}
