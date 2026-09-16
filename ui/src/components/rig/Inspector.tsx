// The inspector, docked under the table (design 2.9): where the selected
// fixture hangs, how it is mounted, where it is focused, and — behind a
// disclosure — how its axes are wired.
//
// These were columns 7 to 16 of the table, which is why the table's header used
// to end mid-word at the right edge of the window. They are per-fixture and you
// set them once; the six that stayed are what you read every time.

import React, { useState } from 'react';
import { Glyph } from '../../glyphs.tsx';
import type { FixtureForm, Project } from '../../../../shared/types.ts';
import { FIXTURE_FORMS, inferFixtureForm, isStructure, offsetOnParent, posFromOffset } from '../../../../shared/types.ts';
import { uid } from '../../../../shared/types.ts';
import { askConfirm } from '../../dialog.tsx';
import { nextFreeAddress } from '../../rig.ts';
import { createGroupFromSelection, lookFromSelection } from '../../selection.ts';
import { profileMeta } from '../../profileInfo.ts';
import { useStore } from '../../store.ts';
import { sortFixtures } from './FixtureTable.tsx';
import { ScrubNumInput } from '../inputs.tsx';
import { AimDegrees, CalControls } from './parts.tsx';

const DEG = Math.PI / 180;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Fixture-form override, per PROFILE.
 *
 *  The importer can only guess what a fixture physically is, and the guess is
 *  sometimes wrong in ways that show: a CLF Nero tilts, so an aim-first rule
 *  calls it a moving head, and it has 1, 7 or 14 cells depending on mode, so a
 *  cell-count rule calls it a bar. It is a 41 × 32 cm blinder plate in all of
 *  them, and drawing it as a cube throwing a cone is visibly wrong.
 *
 *  "auto" stores nothing at all, so the inference stays live. */
function FormSelect({ project, profileId, mutate }: {
  project: Project;
  profileId: string;
  mutate: (fn: (p: Project) => void) => void;
}) {
  const prof = project.profiles?.[profileId];
  if (!prof) return <span className="label dim">—</span>;
  const auto = inferFixtureForm(prof);
  const autoLabel = FIXTURE_FORMS.find((x) => x.value === auto)?.label ?? auto;
  return (
    <select
      className="sel"
      value={prof.formOverride ?? 'auto'}
      title={`how the stage draws and lights this fixture. Applies to every fixture on the "${prof.model}" profile. Auto reads it from the profile — beam angle, whether it steers in both axes, and how its pixels are laid out.`}
      onChange={(e) => mutate((p) => {
        const target = p.profiles?.[profileId];
        if (!target) return;
        if (e.target.value === 'auto') delete target.formOverride;
        else target.formOverride = e.target.value as FixtureForm;
      })}
    >
      <option value="auto">auto — {autoLabel}</option>
      {FIXTURE_FORMS.map((f) => (
        <option key={f.value} value={f.value}>{f.label}</option>
      ))}
    </select>
  );
}

export function Inspector(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const fxSel = useStore((s) => s.fxSel);
  const [showCal, setShowCal] = useState(false);

  const lead = project.fixtures.find((f) => f.id === fxSel[0]);
  if (!lead) {
    return (
      <div className="riginspector">
        <span className="prose">Select a fixture to set where it hangs, how it is mounted and where it is focused.</span>
      </div>
    );
  }
  const meta = profileMeta(project, lead.profileId);
  const many = fxSel.length > 1;

  // editing the lead edits every selected fixture: typed values set them
  // identically, scrubs move them together
  const each = (fn: (x: Project['fixtures'][number]) => void, label?: string) =>
    mutate((p) => {
      for (const id of fxSel) {
        const x = p.fixtures.find((y) => y.id === id);
        if (x) fn(x);
      }
    }, label);

  const setRot = (key: 'rotY' | 'rotX' | 'rotZ', deg: number) =>
    each((x) => {
      const rad = deg * DEG;
      if (key !== 'rotY' && Math.abs(rad) < 1e-9) delete x[key];
      else x[key] = rad;
    }, 'turn the fixture');
  const nudgeRot = (key: 'rotY' | 'rotX' | 'rotZ', dDeg: number) =>
    each((x) => { x[key] = (x[key] ?? 0) + dDeg * DEG; }, 'turn the fixture');
  // Base aim is stored 0..1 (wire-native) but edited as a percentage: 50 % is
  // centre, which is also the default, so an untouched fixture stays absent
  // from the show file rather than pinned at an explicit 0.5.
  const setAim = (key: 'pan' | 'tilt', pct: number) =>
    each((x) => {
      const v = Math.min(1, Math.max(0, pct / 100));
      if (Math.abs(v - 0.5) < 1e-6) delete x[key];
      else x[key] = v;
    }, 'aim the fixture');
  const nudgeAim = (key: 'pan' | 'tilt', dPct: number) =>
    each((x) => { x[key] = Math.min(1, Math.max(0, (x[key] ?? 0.5) + dPct / 100)); }, 'aim the fixture');

  /** structures available to rig on, in stage order so the list reads L→R */
  const structures = (project.props ?? [])
    .filter((pr) => isStructure(pr.kind))
    .sort((a, b) => a.pos.x - b.pos.x);
  const parent = structures.find((st) => st.id === lead.parentId);

  /** Slide a fixture along its parent, keeping its across/height offsets. Each
   *  selected fixture moves by the same DELTA against its own offset, so a row
   *  of heads slides along the bar together instead of collapsing onto a
   *  point. */
  const moveAlongParent = (along: number) =>
    mutate((p) => {
      const led = p.fixtures.find((y) => y.id === lead.id);
      const leadParent = (p.props ?? []).find((pr) => pr.id === led?.parentId);
      if (!led || !leadParent) return;
      const delta = along - offsetOnParent(led, leadParent).along;
      for (const id of fxSel) {
        const f = p.fixtures.find((y) => y.id === id);
        const par = (p.props ?? []).find((pr) => pr.id === f?.parentId);
        if (!f || !par) continue; // unrigged rows in the selection sit still
        const o = offsetOnParent(f, par);
        const np = posFromOffset({ ...o, along: o.along + delta }, par);
        f.pos.x = round2(np.x);
        f.pos.y = round2(np.y);
        f.pos.z = round2(np.z);
      }
    }, 'move along the bar');

  return (
    <div className="riginspector">
      <div className="inspecthead">
        <span className="inspectname">{lead.name}</span>
        <span className="label dim">
          {many ? `editing all ${fxSel.length} selected` : (meta?.label ?? 'unknown profile')}
        </span>
        <span className="grow" />
        <SelectionVerbs />
      </div>
      <div className="inspectgrid">
        <span className="inspectfield">
          <span className="label" title="where it stands on the plan, in metres: across, up, and toward the audience">position</span>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <ScrubNumInput
              key={axis}
              value={lead.pos[axis]}
              scrubStep={0.02}
              decimals={2}
              width={52}
              title={axis === 'x' ? 'across the stage, metres' : axis === 'y' ? 'height off the floor, metres' : 'toward the audience, metres'}
              onSet={(v) => each((x) => { x.pos[axis] = round2(v); }, 'move the fixture')}
              onDelta={(d) => each((x) => { x.pos[axis] = round2(x.pos[axis] + d); }, 'move the fixture')}
            />
          ))}
        </span>
        <span className="inspectfield">
          <span className="label" title="how it is hung: turned about the vertical, tipped forward or back, rolled about its beam. Not where it aims.">mount</span>
          {([
            ['rotY', 'turned about the vertical'],
            ['rotX', 'tipped forward or back — not where it aims'],
            ['rotZ', 'rolled about its beam'],
          ] as const).map(([key, title]) => (
            <ScrubNumInput
              key={key}
              value={Math.round(((key === 'rotY' ? lead.rotY : lead[key] ?? 0) * 180) / Math.PI)}
              scrubStep={1}
              decimals={0}
              width={52}
              title={title}
              onSet={(v) => setRot(key, v)}
              onDelta={(d) => nudgeRot(key, d)}
            />
          ))}
          <span className="label dim">°</span>
        </span>
        <span className="inspectfield">
          <span className="label" title="rigged on a stage structure — it then travels with it. The position above stays in room coordinates.">rigged on</span>
          <select
            className="sel"
            value={lead.parentId ?? ''}
            title="rig this fixture on a stage structure — it then travels with it"
            onChange={(e) => {
              const pid = e.target.value || undefined;
              each((x) => { x.parentId = pid; }, 'rig the fixture on a structure');
            }}
          >
            <option value="">—</option>
            {structures.map((st) => (
              <option key={st.id} value={st.id}>{STRUCTURE_LABEL[st.kind] ?? st.kind} @ {st.pos.x}</option>
            ))}
          </select>
          {parent && (
            <ScrubNumInput
              value={round2(offsetOnParent(lead, parent).along)}
              scrubStep={0.02}
              decimals={2}
              width={52}
              title="metres along the bar from its centre — editing this moves the fixture"
              onSet={(v) => moveAlongParent(v)}
              onDelta={(d) => moveAlongParent(round2(offsetOnParent(lead, parent).along + d))}
            />
          )}
        </span>
        <span className="inspectfield">
          <span className="label" title="what shape of fixture this is — it decides how the stage draws and lights it. Set on the profile, so it applies to every fixture using it.">form</span>
          <FormSelect project={project} profileId={lead.profileId} mutate={mutate} />
        </span>
        {meta?.hasPan && (
          <span className="inspectfield">
            <span className="label" title="base aim: 50 % is centre — a look's pan moves relative to this">aim pan</span>
            <ScrubNumInput
              value={Math.round((lead.pan ?? 0.5) * 100)}
              scrubStep={0.5}
              decimals={0}
              width={52}
              title="base pan: 50 % is centre — looks move relative to this"
              onSet={(v) => setAim('pan', v)}
              onDelta={(d) => nudgeAim('pan', d)}
              suffix={<AimDegrees value={lead.pan} travel={meta.panDeg} />}
            />
          </span>
        )}
        {meta?.hasTilt && (
          <span className="inspectfield">
            <span className="label" title="base aim: 50 % is centre — a look's tilt moves relative to this">aim tilt</span>
            <ScrubNumInput
              value={Math.round((lead.tilt ?? 0.5) * 100)}
              scrubStep={0.5}
              decimals={0}
              width={52}
              title="base tilt: 50 % is centre — looks move relative to this"
              onSet={(v) => setAim('tilt', v)}
              onDelta={(d) => nudgeAim('tilt', d)}
              suffix={<AimDegrees value={lead.tilt} travel={meta.tiltDeg} />}
            />
          </span>
        )}
        {(meta?.hasPan || meta?.hasTilt) && (
          <button
            className="btn small ghost"
            title="which way this head's axes actually run, and how far it may swing. Nothing to do with where it points."
            onClick={() => setShowCal((v) => !v)}
          >
            <Glyph name="chevron" className={showCal ? '' : 'shut'} /> calibration{lead.cal ? ' ·' : ''}
          </button>
        )}
      </div>
      {showCal && (meta?.hasPan || meta?.hasTilt) && (
        <div style={{ marginTop: 8 }}>
          <span className="prose">
            How this head is wired, not where it points. The base aim stays exactly where you focused it.
          </span>
          <CalControls fixture={lead} />
        </div>
      )}
    </div>
  );
}

const STRUCTURE_LABEL: Record<string, string> = {
  trussBar: 'truss bar', trussLeg: 'truss leg', riser: 'riser', screen: 'screen',
};

/** What can be done to the selection, beside the fixture it names.
 *
 *  Not in the bar above the table: the bar is the page's four verbs (design
 *  2.9's wireframe), and five more appearing the moment a row is clicked moved
 *  every row down by a line at the exact moment someone was pointing at one. */
function SelectionVerbs(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const fxSel = useStore((s) => s.fxSel);
  return (
    <>
      <button
        className="btn small"
        title="make a group of these heads, a look that lights them, and put it on an empty pad — then open it"
        onClick={() => void lookFromSelection()}
      >
        + look from selection
      </button>
      <button className="btn small ghost" title="make a group from the selected fixtures" onClick={createGroupFromSelection}>
        ⊕ group from {fxSel.length}
      </button>
      <select
        className="sel"
        value=""
        title="move the selected fixtures to a universe"
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          mutate((p) => {
            for (const f of p.fixtures) if (fxSel.includes(f.id)) f.universeId = id;
          }, 'move the selected fixtures to another universe');
        }}
      >
        <option value="">→ universe…</option>
        {project.universes.map((u) => (
          <option key={u.id} value={u.id}>{u.label}</option>
        ))}
      </select>
      <button
        className="btn small ghost"
        title="duplicate the selected fixtures (next free addresses, offset 0.3 m)"
        onClick={() => {
          const clones: string[] = [];
          const order = sortFixtures(project, 'address', 'asc');
          mutate((p) => {
            for (const f of order) {
              if (!fxSel.includes(f.id)) continue;
              const src = p.fixtures.find((y) => y.id === f.id);
              if (!src) continue;
              const ch = profileMeta(p, src.profileId)?.channels ?? 1;
              const copy = {
                ...structuredClone(src),
                id: uid('fx'),
                name: `${src.name} copy`,
                address: nextFreeAddress(p, src.universeId, ch),
                pos: { ...src.pos, x: src.pos.x + 0.3 },
              };
              p.fixtures.push(copy);
              clones.push(copy.id);
            }
          }, 'duplicate the selected fixtures');
          if (clones.length) useStore.getState().setFxSel(clones);
        }}
      >
        ⧉ duplicate
      </button>
      <button
        className="btn small ghost danger"
        title="delete the selected fixtures"
        onClick={() => {
          void (async () => {
            const ok = await askConfirm(`Delete ${fxSel.length} selected fixture(s)?`, {
              body: 'Groups lose those heads. Undo (⌘Z) brings them back.',
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!ok) return;
            mutate((p) => {
              p.fixtures = p.fixtures.filter((f) => !fxSel.includes(f.id));
              for (const g of p.groups) g.heads = g.heads.filter((h) => !fxSel.includes(h.fixtureId));
            }, 'delete the selected fixtures');
            useStore.getState().setFxSel([]);
          })();
        }}
      >
        <Glyph name="clear" /> delete
      </button>
    </>
  );
}
