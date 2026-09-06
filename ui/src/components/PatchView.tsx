import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FixtureForm, Project } from '../../../shared/types.ts';
import { FIXTURE_FORMS, inferFixtureForm, uid } from '../../../shared/types.ts';
import { PROFILES } from '../../../shared/profiles.ts';
import { allProfileMetas, profileMeta } from '../profileInfo.ts';
import { createGroupFromSelection } from '../selection.ts';
import { ScrubNumInput, TextField } from './inputs.tsx';
import { ShareFixtures } from './ShareFixtures.tsx';
import { useStore } from '../store.ts';
import { STRUCTURE_DEFAULTS, isStructure, offsetOnParent, posFromOffset } from '../../../shared/types.ts';
import { hasUndrivenBeamChannels, isPlaceholderProfile } from '../../../shared/gdtfShare.ts';
import { PixelLayout } from './PixelLayout.tsx';
import { applyAutoGroups, planAutoGroups } from '../autoGroups.ts';
import type { StageProp } from '../../../shared/types.ts';
import { askChoice, askConfirm, askPrompt } from '../dialog.tsx';

/** Columns worth sorting by. Position columns are deliberately absent: they are
 *  for editing, and a table that reorders under a scrub is unusable. */
type SortKey = 'name' | 'profile' | 'universe' | 'address' | 'channels' | 'rigged';

/** A clickable column header.
 *
 *  Module scope, deliberately. Declared inside the component body this is a new
 *  component TYPE on every render, so React unmounts and replaces the <th> — and
 *  the table's pointerup (which clears the selection) re-renders between mouse
 *  down and mouse up, destroying the element the click was going to land on.
 *  Header clicks then do nothing at all, while a programmatic .click() works
 *  fine, because that never triggers the re-render. */
function SortTh({
  k,
  sortKey,
  sortDir,
  onSort,
  children,
  ...rest
}: {
  k: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
} & React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th {...rest} className="sortable" onClick={() => onSort(k)}>
      {children}
      <span className="sortmark">{sortKey === k ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
    </th>
  );
}

/** true when the pointer event originated inside an editing control */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input,select,button,label,option');
}

/** fixture id → true when its address range overlaps another fixture on the same universe */
function findConflicts(p: Project): Set<string> {
  const conflicts = new Set<string>();
  for (const a of p.fixtures) {
    const pa = profileMeta(p, a.profileId);
    if (!pa) continue;
    if (a.address < 1 || a.address + pa.channels - 1 > 512) {
      conflicts.add(a.id);
      continue;
    }
    for (const b of p.fixtures) {
      if (a.id === b.id || a.universeId !== b.universeId) continue;
      const pb = profileMeta(p, b.profileId);
      if (!pb) continue;
      if (a.address < b.address + pb.channels && b.address < a.address + pa.channels) {
        conflicts.add(a.id);
      }
    }
  }
  return conflicts;
}

function nextFreeAddress(p: Project, universeId: string, channels: number): number {
  const used: [number, number][] = p.fixtures
    .filter((f) => f.universeId === universeId)
    .map((f) => [f.address, f.address + (profileMeta(p, f.profileId)?.channels ?? 1) - 1]);
  for (let a = 1; a + channels - 1 <= 512; a++) {
    if (used.every(([lo, hi]) => a + channels - 1 < lo || a > hi)) return a;
  }
  return 1;
}

/** DMX address editor that commits on blur/Enter — not per keystroke — so
 *  half-typed addresses never hit the live rig, and sorted rows don't jump
 *  mid-edit. */
function AddressInput({ value, conflict, onCommit }: {
  value: number;
  conflict: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Never clobber a draft mid-edit: a project echo (a second window, MIDI,
    // OSC, an autosave round-trip) must not erase a half-typed address. Blur
    // re-syncs. The other live-routing inputs have had this guard; this one and
    // BeatsInput were missed.
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Math.max(1, Math.min(512, Number(draft) || 1));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      ref={ref}
      className={`num ${conflict ? 'conflict' : ''}`}
      type="number"
      min={1}
      max={512}
      value={draft}
      title={conflict
        ? 'address overlap — another fixture already uses part of this range'
        : 'DMX start address in this universe (1–512). Commits on Enter or blur; the channel span is shown beside it'}
      style={conflict ? { borderColor: 'var(--hot)', color: 'var(--hot)' } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Fixture-form override, per PROFILE.
 *
 *  The importer can only guess what a fixture physically is, and the guess is
 *  sometimes wrong in ways that show: a CLF Nero tilts, so an aim-first rule
 *  calls it a moving head, and it has 1, 7 or 14 cells depending on mode, so a
 *  cell-count rule calls it a bar. It is a 41 x 32 cm blinder plate in all of
 *  them, and drawing it as a cube throwing a cone is visibly wrong.
 *
 *  "auto" stores nothing at all, so the inference stays live: sharpen the
 *  heuristic and every show that never overrode anything gets the benefit,
 *  while a hand correction survives re-importing the fixture. */
function FormSelect(
  { project, profileId, mutate }:
  { project: Project; profileId: string; mutate: (fn: (p: Project) => void) => void },
) {
  const prof = project.profiles?.[profileId];
  if (!prof) return <span className="label dim">—</span>;
  const auto = inferFixtureForm(prof);
  const autoLabel = FIXTURE_FORMS.find((x) => x.value === auto)?.label ?? auto;
  return (
    <select
      className="sel"
      style={{ width: 130 }}
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

export function PatchView() {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const importMsg = useStore((s) => s.importMsg);
  const fxSel = useStore((s) => s.fxSel);
  const send = useStore((s) => s.send);
  // Select STABLE keys, not the arrays: snap is freshly parsed 20×/s, so
  // `s.snap?.muted` is a new reference every frame and would re-render this
  // 129-row table (and its O(n²) conflict scan) 20 times a second the whole
  // time anything is muted or dark. A joined string changes only when the
  // membership actually does.
  const mutedKey = useStore((s) => (s.snap?.muted ?? []).join(','));
  const unknownKey = useStore((s) => (s.snap?.unknownProfiles ?? []).join(','));
  const muted = useMemo(() => (mutedKey ? mutedKey.split(',') : []), [mutedKey]);
  const unknownProfiles = useMemo(() => (unknownKey ? unknownKey.split(',') : []), [unknownKey]);
  /** Fixtures whose profile is a placeholder — an MVR that travelled without
   *  its real fixture definitions. They are not dark, they just have a dimmer
   *  and nothing else, which looks like a bug in the app until you know. */
  const stubProfiles = useMemo(
    () =>
      new Set(
        Object.entries(project.profiles ?? {})
          .filter(([, pr]) => isPlaceholderProfile(pr))
          .map(([id]) => id),
      ),
    [project],
  );
  /** Profiles carrying beam channels — Zoom, Focus, Iris, Frost, CTO — that
   *  nothing drives. The fixture works, but those parameters are missing from
   *  the look editor with no explanation, because the editor only offers a
   *  control when something in the group actually has that channel. It happens
   *  to profiles compiled by an older importer, or imported from an MVR's flat
   *  console exports: the channel is there by name with no function behind it.
   *  Re-importing the real GDTF fixes it. Until this was surfaced the only
   *  symptom was "why can't I set zoom?". */
  const beamlessProfiles = useMemo(
    () =>
      new Set(
        Object.entries(project.profiles ?? {})
          .filter(([, pr]) => hasUndrivenBeamChannels(pr))
          .map(([id]) => id),
      ),
    [project],
  );
  const identify = useStore((s) => s.snap?.identify) ?? null;
  // O(n²) with a profileMeta allocation per pair — recompute only when the
  // project changes, never on an unrelated re-render.
  const conflicts = useMemo(() => findConflicts(project), [project]);
  // The profile dropdown is identical in every row and rebuilt full metas for
  // every built-in plus every imported profile, per row — ~5,000 metas per
  // render at 40 profiles × 129 rows. Build the options once.
  const profileOptions = useMemo(
    () =>
      allProfileMetas(project).map((pr) => (
        <option key={pr.id} value={pr.id}>
          {pr.imported ? '⇩ ' : ''}
          {pr.label}
        </option>
      )),
    [project],
  );
  const uniOrder = new Map(project.universes.map((u, i) => [u.id, i]));
  /** Column sort. Defaults to patch order — universe then address — because
   *  that is the order the rig is addressed in and the order you walk it. */
  const [sortKey, setSortKey] = useState<SortKey>('address');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir('asc');
    }
  };
  // Patch order — universe, then address — is the default because it is the
  // order the rig is addressed in and the order a DIP-switch check goes in.
  // Sorting by anything else is for finding things, not for working through
  // them, which is why it never becomes the default.
  const sorted = [...project.fixtures].sort((a, b) => {
    const patchOrder = () =>
      (uniOrder.get(a.universeId) ?? 99) - (uniOrder.get(b.universeId) ?? 99) ||
      a.address - b.address;
    const txt = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
    let cmp = 0;
    switch (sortKey) {
      case 'name':
        cmp = txt(a.name, b.name);
        break;
      case 'profile':
        cmp = txt(
          profileMeta(project, a.profileId)?.label ?? a.profileId,
          profileMeta(project, b.profileId)?.label ?? b.profileId,
        );
        break;
      case 'universe':
        cmp = (uniOrder.get(a.universeId) ?? 99) - (uniOrder.get(b.universeId) ?? 99);
        break;
      case 'address':
        cmp = 0; // patch order below already IS address order
        break;
      case 'channels':
        cmp = (profileMeta(project, a.profileId)?.channels ?? 0) -
          (profileMeta(project, b.profileId)?.channels ?? 0);
        break;
      case 'rigged':
        cmp = txt(a.parentId ?? '~', b.parentId ?? '~'); // unrigged sorts last
        break;
    }
    // patch order is the tiebreak for every column, so equal values stay in the
    // order the rig is addressed rather than shuffling arbitrarily
    return (sortDir === 'asc' ? cmp : -cmp) || patchOrder();
  });
  const sortedFixtures = sorted;

  // -- fixture selection: click / ⇧-range / ⌘-toggle / drag-marquee, shared
  //    with the 2D previz through the store's fxSel --
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const anchorRef = useRef<string | null>(null);
  const sortedIdsRef = useRef<string[]>([]);
  sortedIdsRef.current = sortedFixtures.map((f) => f.id);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [marqueeHit, setMarqueeHit] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') useStore.getState().setFxSel([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // an unmount mid-drag (tab switch) must not leak the window drag listeners
  const dragTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragTeardownRef.current?.(), []);

  /** the marquee box clamped to the scrolling tab body — rows scrolled out
   *  of view must never be selectable by an overshooting drag */
  const clampBox = (x0: number, y0: number, x1: number, y1: number) => {
    let box = {
      left: Math.min(x0, x1), right: Math.max(x0, x1),
      top: Math.min(y0, y1), bottom: Math.max(y0, y1),
    };
    const c = tbodyRef.current?.closest('.tabbody')?.getBoundingClientRect();
    if (c) {
      box = {
        left: Math.max(box.left, c.left), right: Math.min(box.right, c.right),
        top: Math.max(box.top, c.top), bottom: Math.min(box.bottom, c.bottom),
      };
    }
    return box;
  };

  const rowsInBox = (x0: number, y0: number, x1: number, y1: number): string[] => {
    const box = clampBox(x0, y0, x1, y1);
    if (box.right <= box.left || box.bottom <= box.top) return [];
    const hit: string[] = [];
    tbodyRef.current?.querySelectorAll('tr[data-fxid]').forEach((tr) => {
      const r = tr.getBoundingClientRect();
      if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) {
        hit.push(tr.getAttribute('data-fxid')!);
      }
    });
    return hit;
  };

  const onTablePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || onControl(e.target)) return;
    // NO preventDefault here: the native mousedown must still blur a focused
    // input — AddressInput commits on blur, and hotkeys stay dead while an
    // input keeps focus. Text selection is already off (body user-select).
    const rowEl = (e.target as Element).closest?.('tr[data-fxid]');
    const startId = rowEl?.getAttribute('data-fxid') ?? null;
    const st = {
      startId,
      shift: e.shiftKey,
      meta: e.metaKey || e.ctrlKey,
      moved: false,
      base: useStore.getState().fxSel,
      x0: e.clientX,
      y0: e.clientY,
    };
    const teardown = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      dragTeardownRef.current = null;
      setMarquee(null);
      setMarqueeHit([]);
    };
    const onCancel = () => teardown();
    const onMove = (me: PointerEvent) => {
      if (!(me.buttons & 1)) {
        // missed pointerup (window lost focus mid-drag) — abort cleanly
        teardown();
        return;
      }
      if (!st.moved && Math.hypot(me.clientX - st.x0, me.clientY - st.y0) > 4) st.moved = true;
      if (st.moved) {
        setMarquee({ x0: st.x0, y0: st.y0, x1: me.clientX, y1: me.clientY });
        setMarqueeHit(rowsInBox(st.x0, st.y0, me.clientX, me.clientY));
      }
    };
    const onUp = (ue: PointerEvent) => {
      teardown();
      const { fxSel: cur, setFxSel } = useStore.getState();
      if (st.moved) {
        const hit = rowsInBox(st.x0, st.y0, ue.clientX, ue.clientY);
        setFxSel(st.shift || st.meta ? [...new Set([...st.base, ...hit])] : hit);
        return;
      }
      if (!st.startId) {
        if (!st.shift && !st.meta) setFxSel([]);
        return;
      }
      if (st.meta) {
        setFxSel(cur.includes(st.startId) ? cur.filter((i) => i !== st.startId) : [...cur, st.startId]);
        anchorRef.current = st.startId;
      } else if (st.shift && anchorRef.current) {
        const ids = sortedIdsRef.current;
        const a = ids.indexOf(anchorRef.current);
        const b = ids.indexOf(st.startId);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setFxSel(ids.slice(lo, hi + 1));
        } else {
          setFxSel([st.startId]);
        }
      } else {
        setFxSel([st.startId]);
        anchorRef.current = st.startId;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    dragTeardownRef.current = teardown;
  };

  // editing a fixture that is part of the multi-selection edits ALL selected
  // fixtures: typed values set them identically, scrubs move them together
  const editTargets = (fid: string): string[] =>
    fxSel.includes(fid) && fxSel.length > 1 ? fxSel : [fid];
  const eachTarget = (fid: string, fn: (x: Project['fixtures'][number]) => void) =>
    mutate((p) => {
      for (const id of editTargets(fid)) {
        const x = p.fixtures.find((y) => y.id === id);
        if (x) fn(x);
      }
    });
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const DEG = Math.PI / 180;
  /** structures available to rig on, in stage order so the list reads L→R */
  const structures = (project.props ?? [])
    .filter((pr) => isStructure(pr.kind))
    .sort((a, b) => a.pos.x - b.pos.x);
  /** Slide a fixture along its parent, keeping its across/height offsets.
   *
   *  Applies to the whole selection, like every other edit in this table — the
   *  legend promises "edits apply to every selected row" and this was the one
   *  control that quietly moved a single fixture. Each selected fixture is
   *  moved by the same DELTA against its own offset, so a row of heads slides
   *  along the bar together instead of collapsing onto one point. */
  const moveAlongParent = (fid: string, along: number) =>
    mutate((p) => {
      const lead = p.fixtures.find((y) => y.id === fid);
      const leadParent = (p.props ?? []).find((pr) => pr.id === lead?.parentId);
      if (!lead || !leadParent) return;
      const delta = along - offsetOnParent(lead, leadParent).along;
      for (const id of editTargets(fid)) {
        const f = p.fixtures.find((y) => y.id === id);
        const parent = (p.props ?? []).find((pr) => pr.id === f?.parentId);
        if (!f || !parent) continue; // unrigged rows in the selection sit still
        const o = offsetOnParent(f, parent);
        const np = posFromOffset({ ...o, along: o.along + delta }, parent);
        f.pos.x = round2(np.x);
        f.pos.y = round2(np.y);
        f.pos.z = round2(np.z);
      }
    });
  const setRot = (fid: string, key: 'rotY' | 'rotX' | 'rotZ', deg: number) =>
    eachTarget(fid, (x) => {
      const rad = deg * DEG;
      if (key !== 'rotY' && Math.abs(rad) < 1e-9) delete x[key];
      else x[key] = rad;
    });
  const nudgeRot = (fid: string, key: 'rotY' | 'rotX' | 'rotZ', dDeg: number) =>
    eachTarget(fid, (x) => {
      x[key] = (x[key] ?? 0) + dDeg * DEG;
    });
  // Base aim is stored 0..1 (wire-native) but edited as a percentage: 50% is
  // centre, which is also the default, so an untouched fixture stays absent
  // from the project rather than pinned at an explicit 0.5.
  const setAim = (fid: string, key: 'pan' | 'tilt', pct: number) =>
    eachTarget(fid, (x) => {
      const v = Math.min(1, Math.max(0, pct / 100));
      if (Math.abs(v - 0.5) < 1e-6) delete x[key];
      else x[key] = v;
    });
  const nudgeAim = (fid: string, key: 'pan' | 'tilt', dPct: number) =>
    eachTarget(fid, (x) => {
      x[key] = Math.min(1, Math.max(0, (x[key] ?? 0.5) + dPct / 100));
    });
  // the columns only exist if something in the patch can actually move
  const anyPan = project.fixtures.some((f) => profileMeta(project, f.profileId)?.hasPan);
  const anyTilt = project.fixtures.some((f) => profileMeta(project, f.profileId)?.hasTilt);

  return (
    <div className="col" style={{ gap: 14 }}>
      {marquee && (() => {
        const box = clampBox(marquee.x0, marquee.y0, marquee.x1, marquee.y1);
        if (box.right <= box.left || box.bottom <= box.top) return null;
        return (
          <div
            style={{
              position: 'fixed',
              left: box.left,
              top: box.top,
              width: box.right - box.left,
              height: box.bottom - box.top,
              background: 'rgba(57,194,255,0.08)',
              border: '1px dashed rgba(57,194,255,0.7)',
              pointerEvents: 'none',
              zIndex: 30,
            }}
          />
        );
      })()}
      {project.fixtures.length === 0 && (
        <div className="prose" style={{ margin: '6px 0 10px' }}>
          No fixtures yet — add one, or import a GDTF for a fixture or an MVR for the whole plot.
          Each fixture takes a universe and a DMX address; the plan above is where it hangs.
        </div>
      )}
      <div onPointerDown={onTablePointerDown}>
        <div className="sectionhead">Fixtures</div>
        <table className="tbl">
          <thead>
            <tr>
              <SortTh k="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>Fixture</SortTh>
              <SortTh k="profile" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>Profile</SortTh>
              <th title="what shape of fixture this is — decides how the stage draws and lights it. Set on the PROFILE, so it applies to every fixture using it.">Form</th>
              <SortTh k="universe" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>Universe</SortTh>
              <SortTh k="address" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>Address</SortTh>
              <SortTh k="channels" sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="how many DMX channels the fixture takes from its address">Channels</SortTh>
              <th>X</th><th>Y</th><th>Z</th><th title="how the fixture is hung: turned about the vertical">Mount rot°</th><th title="how the fixture is hung: tipped forward or back — not where it aims">Mount tilt°</th><th title="how the fixture is hung: rolled about its beam">Mount roll°</th>
              <SortTh k="rigged" sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="rigged on a stage structure — X/Y/Z above stay in room coordinates">
                Rigged on
              </SortTh>
              {anyPan && <th title="base aim: 50% is centre — a look's pan moves relative to this">Aim pan</th>}
              {anyTilt && <th title="base aim: 50% is centre — a look's tilt moves relative to this">Aim tilt</th>}
              <th>Live</th><th></th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {sortedFixtures.map((f) => {
              const prof = profileMeta(project, f.profileId);
              const selected = fxSel.includes(f.id) || marqueeHit.includes(f.id);
              return (
                <tr
                  key={f.id}
                  data-fxid={f.id}
                  className={`${selected ? 'rowsel' : ''} ${unknownProfiles.includes(f.id) ? 'rowdark' : ''} ${stubProfiles.has(f.profileId) ? 'rowstub' : ''} ${beamlessProfiles.has(f.profileId) ? 'rowbeamless' : ''}`}
                  title={
                    unknownProfiles.includes(f.id)
                      ? 'this fixture\'s profile is missing — it renders as nothing at all. Re-import the profile or pick another one.'
                      : stubProfiles.has(f.profileId)
                        ? 'placeholder profile: the MVR that brought this fixture in did not carry a real fixture definition, so it has a dimmer and nothing else. Fetch the real one in GDTF Share below, then set it here.'
                        : beamlessProfiles.has(f.profileId)
                          ? 'this profile lists beam channels (zoom, focus, beam size, soften, warmth) that nothing drives, so the look editor cannot offer them. It was compiled from a thin GDTF or by an older importer — re-import the real GDTF for this fixture and the controls appear.'
                          : undefined
                  }
                >
                  <td>
                    <TextField
                      className="text"
                      title="fixture name — shown in the plan and in group lists"
                      style={{ width: 130 }}
                      entityId={f.id}
                      value={f.name}
                      onCommit={(v) => mutate((p) => {
                        const x = p.fixtures.find((y) => y.id === f.id);
                        if (x) x.name = v;
                      })}
                    />
                  </td>
                  <td>
                    <select
                      className="sel"
                      value={f.profileId}
                      title={
                        editTargets(f.id).length > 1
                          ? `changes the profile on all ${editTargets(f.id).length} selected fixtures`
                          : 'fixture profile'
                      }
                      onChange={(e) => eachTarget(f.id, (x) => { x.profileId = e.target.value; })}
                    >
                      {profileOptions}
                    </select>
                  </td>
                  <td>
                    <FormSelect project={project} profileId={f.profileId} mutate={mutate} />
                  </td>
                  <td>
                    <select
                      className="sel"
                      value={f.universeId}
                      title={
                        editTargets(f.id).length > 1
                          ? `moves all ${editTargets(f.id).length} selected fixtures to that universe`
                          : 'output universe'
                      }
                      onChange={(e) => eachTarget(f.id, (x) => { x.universeId = e.target.value; })}
                    >
                      {project.universes.map((u) => (
                        <option key={u.id} value={u.id}>{u.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <AddressInput
                        value={f.address}
                        conflict={conflicts.has(f.id)}
                        onCommit={(v) => mutate((p) => {
                          const x = p.fixtures.find((y) => y.id === f.id);
                          if (x) x.address = v;
                        })}
                      />
                      <span className="label" style={{ fontFamily: 'var(--mono)' }}>
                        –{f.address + (prof?.channels ?? 1) - 1}
                      </span>
                    </div>
                  </td>
                  <td className="mono">{prof?.channels ?? '?'}</td>
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <td key={axis}>
                      <ScrubNumInput
                        value={f.pos[axis]}
                        scrubStep={0.02}
                        decimals={2}
                        title={axis.toUpperCase()}
                        onSet={(v) => eachTarget(f.id, (x) => { x.pos[axis] = round2(v); })}
                        onDelta={(d) => eachTarget(f.id, (x) => { x.pos[axis] = round2(x.pos[axis] + d); })}
                      />
                    </td>
                  ))}
                  <td>
                    <ScrubNumInput
                      value={Math.round((f.rotY * 180) / Math.PI)}
                      scrubStep={1}
                      decimals={0}
                      title="rotation (yaw)"
                      onSet={(v) => setRot(f.id, 'rotY', v)}
                      onDelta={(d) => nudgeRot(f.id, 'rotY', d)}
                    />
                  </td>
                  <td>
                    <ScrubNumInput
                      value={Math.round(((f.rotX ?? 0) * 180) / Math.PI)}
                      scrubStep={1}
                      decimals={0}
                      title="tilt (pitch) — composes on the fixture's default aim"
                      onSet={(v) => setRot(f.id, 'rotX', v)}
                      onDelta={(d) => nudgeRot(f.id, 'rotX', d)}
                    />
                  </td>
                  <td>
                    <ScrubNumInput
                      value={Math.round(((f.rotZ ?? 0) * 180) / Math.PI)}
                      scrubStep={1}
                      decimals={0}
                      title="roll"
                      onSet={(v) => setRot(f.id, 'rotZ', v)}
                      onDelta={(d) => nudgeRot(f.id, 'rotZ', d)}
                    />
                  </td>
                  {/* Rigged on: the parent, and where the fixture sits along it.
                      Both frames at once — X/Y/Z above stay room coordinates so
                      nothing about the existing table changes meaning, and the
                      offset here is derived, so the two can never disagree. */}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <select
                      className="sel"
                      style={{ maxWidth: 110 }}
                      value={f.parentId ?? ''}
                      title="rig this fixture on a stage structure — it then travels with it"
                      onChange={(e) => {
                        const pid = e.target.value || undefined;
                        eachTarget(f.id, (x) => { x.parentId = pid; });
                      }}
                    >
                      <option value="">—</option>
                      {structures.map((st) => (
                        <option key={st.id} value={st.id}>
                          {STRUCTURE_LABEL[st.kind] ?? st.kind} @ {st.pos.x}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const parent = structures.find((st) => st.id === f.parentId);
                      if (!parent) return null;
                      const o = offsetOnParent(f, parent);
                      return (
                        <span style={{ marginLeft: 4, display: 'inline-block' }}>
                          <ScrubNumInput
                            value={round2(o.along)}
                            scrubStep={0.02}
                            decimals={2}
                            title="metres along the bar from its centre — editing this moves the fixture"
                            onSet={(v) => moveAlongParent(f.id, v)}
                            onDelta={(d) => moveAlongParent(f.id, round2(o.along + d))}
                          />
                        </span>
                      );
                    })()}
                  </td>
                  {anyPan && (
                    <td>
                      {profileMeta(project, f.profileId)?.hasPan ? (
                        <ScrubNumInput
                          value={Math.round((f.pan ?? 0.5) * 100)}
                          scrubStep={0.5}
                          decimals={0}
                          title="base pan: 50% is centre — looks move relative to this"
                          onSet={(v) => setAim(f.id, 'pan', v)}
                          onDelta={(d) => nudgeAim(f.id, 'pan', d)}
                        />
                      ) : (
                        <span className="label dim">—</span>
                      )}
                    </td>
                  )}
                  {anyTilt && (
                    <td>
                      {profileMeta(project, f.profileId)?.hasTilt ? (
                        <ScrubNumInput
                          value={Math.round((f.tilt ?? 0.5) * 100)}
                          scrubStep={0.5}
                          decimals={0}
                          title="base tilt: 50% is centre — looks move relative to this"
                          onSet={(v) => setAim(f.id, 'tilt', v)}
                          onDelta={(d) => nudgeAim(f.id, 'tilt', d)}
                        />
                      ) : (
                        <span className="label dim">—</span>
                      )}
                    </td>
                  )}
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        className={`btn small ${muted.includes(f.id) ? 'danger on' : 'ghost'}`}
                        title={muted.includes(f.id)
                          ? 'muted — this fixture is receiving all zeros. Click to bring it back.'
                          : 'mute: silence this fixture without touching the patch (stuck or dead unit)'}
                        onClick={() => send({ type: 'setFixtureMute', fixtureId: f.id, on: !muted.includes(f.id) })}
                      >
                        {muted.includes(f.id) ? 'muted' : 'mute'}
                      </button>
                      <button
                        className={`btn small ${identify === f.id ? 'on' : 'ghost'}`}
                        title="find this light: drive it to full white so you can spot it on the truss"
                        onClick={() => send({ type: 'identify', fixtureId: identify === f.id ? null : f.id })}
                      >
                        ◎
                      </button>
                    </div>
                  </td>
                  <td>
                    <button
                      title="delete this fixture — it leaves the patch and every group it is in"
                      className="btn small ghost"
                      onClick={() => {
                        void (async () => {
                          const ok = await askConfirm(`Delete "${f.name}"?`, {
                            body: 'It is removed from the patch and from every group.',
                            confirmLabel: 'Delete',
                            danger: true,
                          });
                          if (!ok) return;
                          mutate((p) => {
                            p.fixtures = p.fixtures.filter((x) => x.id !== f.id);
                            for (const g of p.groups) g.heads = g.heads.filter((h) => h.fixtureId !== f.id);
                          });
                          const { fxSel: cur, setFxSel } = useStore.getState();
                          if (cur.includes(f.id)) setFxSel(cur.filter((i) => i !== f.id));
                        })();
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="btn small"
            onClick={() => mutate((p) => {
              const profile = PROFILES['generic-rgb-par-3ch'];
              const universeId = p.universes[0]?.id ?? 'u1';
              p.fixtures.push({
                id: uid('fx'),
                name: `Fixture ${p.fixtures.length + 1}`,
                profileId: profile.id,
                universeId,
                address: nextFreeAddress(p, universeId, profile.channels),
                pos: { x: 0, y: 2, z: 0 },
                rotY: 0,
              });
            })}
            title="add one fixture at the next free address in the selected universe"
          >
            + add fixture
          </button>
          <label
            className="btn small"
            style={{ cursor: 'pointer' }}
            title="import a GDTF fixture definition, or an MVR scene (fixtures, addresses, positions and the definitions inside it). Re-importing a file replaces the stored profile; undo puts the old one back."
          >
            ⇩ import .gdtf / .mvr
            <input
              type="file"
              accept=".gdtf,.mvr"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const isMvr = file.name.toLowerCase().endsWith('.mvr');
                const reader = new FileReader();
                reader.onload = () => {
                  const b64 = String(reader.result).split(',')[1] ?? '';
                  if (!isMvr) {
                    useStore.getState().send({ type: 'importGdtf', name: file.name, data: b64 });
                    return;
                  }
                  // three explicit choices — replacing the whole patch must
                  // never be what Esc or Cancel does
                  void askChoice(`Import "${file.name}"`, [
                    { value: 'merge', label: 'Merge into patch', primary: true },
                    { value: 'replace', label: 'Replace everything', danger: true },
                  ], {
                    body:
                      'Merge adds the scene’s fixtures to the current patch. Replace clears the patch, groups and looks first — undo brings them back.\n\n' +
                      'Either way the scene’s addressing wins for the fixtures it brings in, and any universe the scene needs is created with its output switched OFF. Turn those on in Output once you have checked the addresses.',
                  }).then((choice) => {
                    if (!choice) return;
                    useStore.getState().send({
                      type: 'importMvr', name: file.name, data: b64, replace: choice === 'replace',
                    });
                  });
                };
                reader.readAsDataURL(file);
                e.target.value = '';
              }}
            />
          </label>
          <button
            className="btn small ghost"
            title="re-address every fixture sequentially per universe, keeping the current order"
            onClick={() => {
              void (async () => {
              if (!(await askConfirm('Re-address every fixture?', {
                body: 'Fixtures are packed sequentially per universe, keeping their current order. Your hardware DIP switches must match afterwards.',
                confirmLabel: 'Re-address all',
              }))) return;
              mutate((p) => {
                for (const u of p.universes) {
                  let addr = 1;
                  const inU = p.fixtures
                    .filter((f) => f.universeId === u.id)
                    .sort((a, b) => a.address - b.address);
                  for (const f of inU) {
                    f.address = addr;
                    addr += profileMeta(p, f.profileId)?.channels ?? 1;
                  }
                }
              });
              })();
            }}
          >
            auto-pack addresses
          </button>
          {structures.length > 0 && (
            <button
              className="btn small ghost"
              title="re-address in rigging order: truss by truss, then left to right along each bar"
              onClick={() => {
                void (async () => {
                  if (
                    !(await askConfirm('Re-address by truss?', {
                      body:
                        'Fixtures are packed per universe in rigging order: truss by truss (upstage first, then left to right), and along each bar left to right. Anything not rigged on a structure keeps its current order and goes last. Your hardware DIP switches must match afterwards.',
                      confirmLabel: 'Re-address by truss',
                    }))
                  )
                    return;
                  mutate((p) => {
                    const structs = (p.props ?? []).filter((pr) => isStructure(pr.kind));
                    // Trusses read the way you walk the rig: upstage bars first,
                    // then left to right. Unparented fixtures keep their existing
                    // order and land after everything that has a home.
                    const order = [...structs].sort((a, b) => a.pos.z - b.pos.z || a.pos.x - b.pos.x);
                    const rank = new Map(order.map((st, i) => [st.id, i]));
                    const alongOf = (f: Project['fixtures'][number]) => {
                      const parent = structs.find((st) => st.id === f.parentId);
                      return parent ? offsetOnParent(f, parent).along : 0;
                    };
                    for (const u of p.universes) {
                      let addr = 1;
                      const inU = p.fixtures
                        .filter((f) => f.universeId === u.id)
                        .sort((a, b) => {
                          const ra = a.parentId ? rank.get(a.parentId) ?? 1e6 : 1e6;
                          const rb = b.parentId ? rank.get(b.parentId) ?? 1e6 : 1e6;
                          if (ra !== rb) return ra - rb;
                          if (ra === 1e6) return a.address - b.address; // unrigged: leave be
                          return alongOf(a) - alongOf(b);
                        });
                      for (const f of inU) {
                        f.address = addr;
                        addr += profileMeta(p, f.profileId)?.channels ?? 1;
                      }
                    }
                  });
                })();
              }}
            >
              auto-address by truss
            </button>
          )}
          {fxSel.length > 0 && (
            <>
              <button
                className="btn small"
                onClick={createGroupFromSelection}
                title="Create a group from the selected fixtures"
              >
                ⊕ group from {fxSel.length} selected
              </button>
              <select
                className="sel"
                value=""
                title="move the selected fixtures to a universe"
                onChange={(e) => {
                  const uid = e.target.value;
                  if (!uid) return;
                  mutate((p) => {
                    for (const f of p.fixtures) if (fxSel.includes(f.id)) f.universeId = uid;
                  });
                }}
              >
                <option value="">→ universe…</option>
                {project.universes.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
              <button
                className="btn small ghost"
                title="re-address the selected fixtures sequentially, keeping their current order"
                onClick={() => {
                  void (async () => {
                  const startStr = await askPrompt('Re-address selected fixtures', '1', {
                    body: 'They are packed sequentially from this start address, in table order.',
                    confirmLabel: 'Re-address',
                  });
                  if (startStr === null) return;
                  const start = Math.max(1, Math.min(512, Number(startStr) || 1));
                  mutate((p) => {
                    let addr = start;
                    for (const f of sortedFixtures) {
                      if (!fxSel.includes(f.id)) continue;
                      const x = p.fixtures.find((y) => y.id === f.id);
                      const ch = profileMeta(p, f.profileId)?.channels ?? 1;
                      if (!x || addr + ch - 1 > 512) continue;
                      x.address = addr;
                      addr += ch;
                    }
                  });
                  })();
                }}
              >
                ⇢ re-address
              </button>
              <button
                className="btn small ghost"
                title="duplicate the selected fixtures (next free addresses, offset 0.3 m)"
                onClick={() => {
                  const clones: string[] = [];
                  mutate((p) => {
                    for (const f of sortedFixtures) {
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
                  });
                  if (clones.length) useStore.getState().setFxSel(clones);
                }}
              >
                ⧉ duplicate
              </button>
              <button
                className="btn small ghost"
                style={{ color: 'var(--hot)' }}
                title="delete the selected fixtures"
                onClick={() => {
                  void (async () => {
                    const ok = await askConfirm(`Delete ${fxSel.length} selected fixture(s)?`, {
                      body: 'Groups lose those heads. Undo (⌘Z) restores the patch.',
                      confirmLabel: 'Delete',
                      danger: true,
                    });
                    if (!ok) return;
                    mutate((p) => {
                      p.fixtures = p.fixtures.filter((f) => !fxSel.includes(f.id));
                      for (const g of p.groups) g.heads = g.heads.filter((h) => !fxSel.includes(h.fixtureId));
                    });
                    useStore.getState().setFxSel([]);
                  })();
                }}
              >
                ✕ delete
              </button>
            </>
          )}
          {conflicts.size > 0 && (
            <span className="label" style={{ color: 'var(--hot)' }}>
              {conflicts.size} address conflict{conflicts.size > 1 ? 's' : ''}
            </span>
          )}
          <span className="label">click / ⇧-range / drag-box selects rows · number fields scrub by dragging · edits apply to every selected row</span>
          {importMsg && (
            <span className="label" style={{ color: importMsg.ok ? 'var(--good)' : 'var(--hot)' }}>
              {importMsg.text}
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="sectionhead">
          Groups
          <button
            className="btn small ghost"
            style={{ marginLeft: 10 }}
            title="derive groups from the rig: one per fixture type, one per truss (ordered along the bar). Groups you have renamed or edited are yours and are never touched."
            onClick={() => {
              void (async () => {
                const plan = planAutoGroups(project);
                if (plan.create.length + plan.update.length + plan.remove.length === 0) {
                  await askConfirm('Auto-groups are up to date', { body: 'Nothing to create, update or remove.', confirmLabel: 'OK' });
                  return;
                }
                const lines: string[] = [];
                if (plan.create.length) lines.push(`Create: ${plan.create.map((g) => `${g.name} (${g.heads.length})`).join(', ')}`);
                if (plan.update.length) lines.push(`Update membership: ${plan.update.map((u) => u.existing.name).join(', ')}`);
                if (plan.remove.length) lines.push(`Remove (source gone): ${plan.remove.map((g) => g.name).join(', ')}`);
                const ok = await askConfirm('Regenerate auto-groups?', {
                  body: lines.join('\n\n') + '\n\nRenamed or hand-edited groups are not auto-managed and stay untouched.',
                  confirmLabel: 'Apply',
                });
                if (ok) mutate((p) => applyAutoGroups(p, planAutoGroups(p)));
              })();
            }}
          >
            ⟳ auto-groups
          </button>
        </div>
        {project.groups.map((g) => (
          <div key={g.id} className="row" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
            <TextField
              className="text"
              title="group name — renaming a generated group makes it yours, and ⟳ leaves it alone after that"
              style={{ width: 130 }}
              entityId={g.id}
              value={g.name}
              onCommit={(v) => mutate((p) => {
                const x = p.groups.find((y) => y.id === g.id);
                if (!x || x.name === v) return;
                x.name = v;
                delete x.auto; // renamed = promoted to authored: regenerate keeps its hands off
              })}
            />
            {g.auto !== undefined && (
              <span
                className="chip"
                title="derived group — ⟳ may rewrite it; click to pin as yours (renaming or editing also promotes it)"
                style={{ cursor: 'pointer' }}
                onClick={() => mutate((p) => {
                  const x = p.groups.find((y) => y.id === g.id);
                  if (x) delete x.auto;
                })}
              >
                auto
              </span>
            )}
            <div className="grow" style={{ lineHeight: 1.9 }}>
              {project.fixtures.flatMap((f) => {
                const prof = profileMeta(project, f.profileId);
                if (!prof) return [];
                return prof.heads.map((hd, hi) => {
                  const on = g.heads.some((h) => h.fixtureId === f.id && h.head === hi);
                  const label = prof.heads.length > 1 ? `${f.name}·${hd.label}` : f.name;
                  const pos = g.heads.findIndex((h) => h.fixtureId === f.id && h.head === hi);
                  return (
                    <span
                      key={`${f.id}:${hi}`}
                      title={on ? `chase position ${pos + 1}` : 'click to add to this group'}
                      className={`headchip ${on ? 'on' : ''}`}
                      role="checkbox"
                      aria-checked={on}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                      onClick={() => mutate((p) => {
                        const x = p.groups.find((y) => y.id === g.id);
                        if (!x) return;
                        const idx = x.heads.findIndex((h) => h.fixtureId === f.id && h.head === hi);
                        if (idx >= 0) x.heads.splice(idx, 1);
                        else x.heads.push({ fixtureId: f.id, head: hi });
                        delete x.auto; // edited membership = promoted to authored
                      })}
                    >
                      {on ? `${pos + 1}· ` : ''}{label}
                    </span>
                  );
                });
              })}
            </div>
            <button
              className="btn small ghost"
              title="reverse the chase order — one click when a bar is hung the other way round"
              disabled={g.heads.length < 2}
              onClick={() => mutate((p) => {
                const x = p.groups.find((y) => y.id === g.id);
                if (!x) return;
                x.heads.reverse();
                delete x.auto; // edited chase order = promoted to authored
              })}
            >
              ⇄
            </button>
            <button
              className="btn small ghost"
              title="delete group"
              onClick={() => {
                void (async () => {
                  const users = Object.values(project.looks).filter((lk) =>
                    lk.parts.some((pt) => pt.groupId === g.id),
                  );
                  if (users.length > 0) {
                    const ok = await askConfirm(`Delete group "${g.name}"?`, {
                      body: `${users.length} look(s) target it: ${users.map((l) => l.name).join(', ')}. Those parts will stop rendering until you point them at another group.`,
                      confirmLabel: 'Delete group',
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  mutate((p) => {
                    p.groups = p.groups.filter((x) => x.id !== g.id);
                  });
                })();
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="btn small"
          onClick={() => mutate((p) => p.groups.push({ id: uid('g'), name: `Group ${p.groups.length + 1}`, heads: [] }))}
        
            title="a named set of heads. Groups are what looks point at, and their order is chase order.">
          + add group
        </button>
        <div className="label" style={{ marginTop: 6 }}>chip order = chase order (first chip runs first)</div>
      </div>

      <PixelLayout />
      <StageTable />
      <ShareFixtures />
    </div>
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The hand-drawn stage: truss, legs, risers, screens.
 *
 *  Placing by dragging in the plan gets you close; a truss that has to be
 *  exactly 6 m, or a riser at exactly 0.6 m, needs numbers. Selection is shared
 *  with the plan through the store, so a row highlights what it refers to. */
function StageTable() {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const propSel = useStore((s) => s.propSel);
  const setPropSel = useStore((s) => s.setPropSel);
  const items = (project.props ?? []).filter((p) => isStructure(p.kind));
  if (items.length === 0) {
    return (
      <div className="patchsec">
        <div className="sectionhead">Stage</div>
        <div className="prose">
          Nothing drawn yet — add truss, risers or screens from the stage's “+ structure…” menu,
          then drag them into place in the 2D plan.
        </div>
      </div>
    );
  }

  const edit = (id: string, fn: (p: StageProp) => void) =>
    mutate((p) => {
      const target = (p.props ?? []).find((x) => x.id === id);
      if (target) fn(target);
    });
  const sizeOf = (pr: StageProp) =>
    pr.size ?? STRUCTURE_DEFAULTS[pr.kind] ?? { w: 1, h: 1, d: 1 };

  return (
    <div className="patchsec">
      <div className="sectionhead">Stage</div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Piece</th><th>X</th><th>Z</th><th>Base Y</th>
            <th>Width</th><th>Height</th><th>Depth</th><th>Rot°</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((pr) => {
            const s = sizeOf(pr);
            const selected = propSel.includes(pr.id);
            const num = (
              value: number, step: number, title: string, set: (v: number) => void,
            ) => (
              <ScrubNumInput
                value={value}
                scrubStep={step}
                decimals={2}
                title={title}
                onSet={(v) => set(round2(v))}
                onDelta={(d) => set(round2(value + d))}
              />
            );
            return (
              <tr
                key={pr.id}
                className={selected ? 'rowsel' : ''}
                onPointerDown={(e) => {
                  if (onControl(e.target)) return;
                  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                  setPropSel(
                    additive
                      ? propSel.includes(pr.id) ? propSel.filter((x) => x !== pr.id) : [...propSel, pr.id]
                      : [pr.id],
                  );
                }}
              >
                <td className="mono">{STRUCTURE_LABEL[pr.kind] ?? pr.kind}</td>
                <td>{num(pr.pos.x, 0.02, 'across the stage', (v) => edit(pr.id, (x) => { x.pos.x = v; }))}</td>
                <td>{num(pr.pos.z, 0.02, 'toward the audience', (v) => edit(pr.id, (x) => { x.pos.z = v; }))}</td>
                <td>{num(pr.y ?? 0, 0.02, 'height of the base off the floor', (v) => edit(pr.id, (x) => { x.y = v; }))}</td>
                <td>{num(s.w, 0.05, 'width', (v) => edit(pr.id, (x) => { x.size = { ...sizeOf(x), w: Math.max(0.05, v) }; }))}</td>
                <td>{num(s.h, 0.05, 'height', (v) => edit(pr.id, (x) => { x.size = { ...sizeOf(x), h: Math.max(0.05, v) }; }))}</td>
                <td>{num(s.d, 0.05, 'depth', (v) => edit(pr.id, (x) => { x.size = { ...sizeOf(x), d: Math.max(0.05, v) }; }))}</td>
                <td>
                  <ScrubNumInput
                    value={Math.round(((pr.rotY ?? 0) * 180) / Math.PI)}
                    scrubStep={1}
                    decimals={0}
                    title="rotation"
                    onSet={(v) => edit(pr.id, (x) => { x.rotY = (v * Math.PI) / 180; })}
                    onDelta={(d) => edit(pr.id, (x) => { x.rotY = ((x.rotY ?? 0) + (d * Math.PI) / 180); })}
                  />
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button
                    className="btn small ghost"
                    title="duplicate — lands 0.5 m across so it is not hidden underneath"
                    onClick={() =>
                      mutate((p) => {
                        const src = (p.props ?? []).find((x) => x.id === pr.id);
                        if (!src) return;
                        p.props ??= [];
                        p.props.push({
                          ...structuredClone(src),
                          id: uid('prop'),
                          pos: { x: round2(src.pos.x + 0.5), z: src.pos.z },
                        });
                      })
                    }
                  >
                    ⧉
                  </button>
                  <button
                    className="btn small ghost"
                    title="delete"
                    onClick={() =>
                      mutate((p) => {
                        p.props = (p.props ?? []).filter((x) => x.id !== pr.id);
                        if (p.props.length === 0) delete p.props;
                        // Anything rigged on it is no longer rigged on
                        // anything: a stale parentId renders the Rigged-on
                        // select blank (no matching option) and takes the
                        // along-the-bar scrub with it. Positions are in room
                        // coordinates, so the fixtures stay exactly where they
                        // are — they simply stop having a parent.
                        for (const f of p.fixtures) {
                          if (f.parentId === pr.id) delete f.parentId;
                        }
                      })
                    }
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="label" style={{ marginTop: 6 }}>
        drag a row's numbers to scrub · shift-click rows to multi-select · ⧉ duplicates, ✕ deletes
      </div>
    </div>
  );
}

const STRUCTURE_LABEL: Record<string, string> = {
  trussBar: 'truss bar', trussLeg: 'truss leg', riser: 'riser', screen: 'screen',
};
