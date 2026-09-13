// The Rig page (design 2.9): a section rail, the fixtures table with an
// inspector docked under it, and the plan as a column beside them.
//
// What it replaces: one 1,080-line scroll with the fixture library three
// screens down, a sixteen-column table whose header ran off the right edge of
// the window, and a plan borrowed from the band above a live stage.

import React, { useEffect, useMemo, useRef } from 'react';
import { findConflicts } from '../../rig.ts';
import { RIG_SECTIONS, useRig, type RigSection } from '../../rigStore.ts';
import { useStore } from '../../store.ts';
import { FixtureLibrary } from '../FixtureLibrary.tsx';
import { ShareFixtures } from '../ShareFixtures.tsx';
import { FixtureBar, FixtureTable } from './FixtureTable.tsx';
import { GroupsSection } from './GroupsSection.tsx';
import { Inspector } from './Inspector.tsx';
import { PlanColumn } from './PlanColumn.tsx';
import { ProfilesSection } from './ProfilesSection.tsx';
import { StageSection } from './StageSection.tsx';
import '../../styles/rig.css';

export function RigView(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const section = useRig((s) => s.section);
  const jump = useRig((s) => s.jump);
  const setSection = useRig((s) => s.setSection);
  const jumpTo = useRig((s) => s.jumpTo);
  const scroller = useRef<HTMLDivElement>(null);

  // O(n²) with a profileMeta allocation per pair — recompute only when the
  // show changes, never on an unrelated re-render.
  const conflicts = useMemo(() => findConflicts(project), [project]);

  // Asked for a section: go to it. Only a jump scrolls — the spy below reports
  // where the page IS, and letting that scroll would be a loop.
  useEffect(() => {
    if (!jump) return;
    const el = scroller.current?.querySelector(`[data-rigsec="${useRig.getState().section}"]`);
    el?.scrollIntoView({ block: 'start' });
  }, [jump]);

  // Which entry is lit: the topmost section the column is actually showing.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = top?.target.getAttribute('data-rigsec') as RigSection | null;
        if (id && id !== useRig.getState().section) setSection(id);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    root.querySelectorAll('[data-rigsec]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [setSection]);

  const counts: Record<RigSection, number | null> = {
    fixtures: project.fixtures.length,
    groups: project.groups.length,
    stage: (project.props ?? []).length,
    profiles: Object.keys(project.profiles ?? {}).length,
    library: null,
  };

  return (
    <div className="rigpage">
      <nav className="rigrail" aria-label="rig sections">
        {RIG_SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`railentry ${section === s.id ? 'on' : ''}`}
            title={s.help}
            aria-current={section === s.id}
            onClick={() => jumpTo(s.id)}
          >
            {s.label}
            {counts[s.id] !== null && <span className="count">{counts[s.id]}</span>}
          </button>
        ))}
      </nav>

      <div className="rigmain">
        <FixtureBar conflicts={conflicts} />
        <div className="rigsections" ref={scroller}>
          <section className="rigsec" data-rigsec="fixtures">
            <div className="sectionhead" data-setup="fixtures">Fixtures</div>
            <FixtureTable conflicts={conflicts} />
          </section>
          <section className="rigsec" data-rigsec="groups">
            <GroupsSection />
          </section>
          <section className="rigsec" data-rigsec="stage">
            <StageSection />
          </section>
          <section className="rigsec" data-rigsec="profiles">
            <ProfilesSection />
          </section>
          <section className="rigsec" data-rigsec="library">
            <FixtureLibrary />
            <ShareFixtures />
          </section>
        </div>
        <Inspector />
      </div>

      <PlanColumn />
    </div>
  );
}
