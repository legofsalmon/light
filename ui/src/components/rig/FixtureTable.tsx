// The lean fixtures table (design 2.9, R3): name, profile, universe, the
// address as ONE mono range, channels, and the live pair. Everything that is
// about where a fixture hangs rather than what it answers to has moved to the
// inspector under the table, so the header no longer runs off the right edge.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../../shared/types.ts';
import { uid } from '../../../../shared/types.ts';
import { askChoice, askConfirm, askPrompt } from '../../dialog.tsx';
import { allProfileMetas, profileMeta } from '../../profileInfo.ts';
import { isStructure, offsetOnParent } from '../../../../shared/types.ts';
import { isPlaceholderProfile, profileNeedsRebuild } from '../../../../shared/gdtfShare.ts';
import { addressRange, matchesFind, nextFreeAddress } from '../../rig.ts';
import { librarySave, shareAvailable } from '../../share.ts';
import { useRig } from '../../rigStore.ts';
import { useStore } from '../../store.ts';
import { TextField } from '../inputs.tsx';
import { AddFixture } from './AddFixture.tsx';
import { AddressCell, FindButton, MuteButton, onControl, usePopover } from './parts.tsx';

/** Columns worth sorting by. Patch order — universe, then address — is the
 *  default, because that is the order the rig is addressed in and the order a
 *  DIP-switch check goes in. */
export type SortKey = 'name' | 'profile' | 'universe' | 'address' | 'channels';

/** The design's 1024 widths (2.9): name 140 sticky · profile 120 · U 28 ·
 *  addr 64 · ch 36 · the live pair 66. A fixed layout shares anything wider
 *  out in these proportions, so the table reads the same on every window. */
const COLS = { name: 140, profile: 120, universe: 28, address: 64, channels: 36, live: 66 };
const TABLE_MIN = Object.values(COLS).reduce((a, b) => a + b, 0) + 6 * 12;

/** A clickable column header.
 *
 *  Module scope, deliberately. Declared inside the component body this is a new
 *  component TYPE on every render, so React unmounts and replaces the <th> —
 *  and the table's pointerup (which clears the selection) re-renders between
 *  mouse down and mouse up, destroying the element the click was going to land
 *  on. Header clicks then do nothing at all. */
function SortTh({ k, sortKey, sortDir, onSort, children, ...rest }: {
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

/** Fixtures in the order the table shows them. */
export function sortFixtures(
  project: Project, sortKey: SortKey, sortDir: 'asc' | 'desc',
): Project['fixtures'] {
  const uniOrder = new Map(project.universes.map((u, i) => [u.id, i]));
  const patchOrder = (a: Project['fixtures'][number], b: Project['fixtures'][number]) =>
    (uniOrder.get(a.universeId) ?? 99) - (uniOrder.get(b.universeId) ?? 99) || a.address - b.address;
  const txt = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
  return [...project.fixtures].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'name': cmp = txt(a.name, b.name); break;
      case 'profile':
        cmp = txt(
          profileMeta(project, a.profileId)?.label ?? a.profileId,
          profileMeta(project, b.profileId)?.label ?? b.profileId,
        );
        break;
      case 'universe': cmp = (uniOrder.get(a.universeId) ?? 99) - (uniOrder.get(b.universeId) ?? 99); break;
      case 'address': cmp = 0; break; // patch order below already IS address order
      case 'channels':
        cmp = (profileMeta(project, a.profileId)?.channels ?? 0) - (profileMeta(project, b.profileId)?.channels ?? 0);
        break;
    }
    // patch order is the tiebreak for every column, so equal values keep the
    // order the rig is addressed in rather than shuffling arbitrarily
    return (sortDir === 'asc' ? cmp : -cmp) || patchOrder(a, b);
  });
}

/** The bar above the table: find, add, import, re-address, and what can be
 *  done with a selection. */
export function FixtureBar({ conflicts }: { conflicts: Set<string> }): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const fxSel = useStore((s) => s.fxSel);
  const importMsg = useStore((s) => s.importMsg);
  const find = useRig((s) => s.find);
  const setFind = useRig((s) => s.setFind);
  const [showConflicts, setShowConflicts] = useState(false);
  const readdr = usePopover();

  const conflictRows = project.fixtures.filter((f) => conflicts.has(f.id));

  const repack = (byTruss: boolean) =>
    mutate((p) => {
      const structs = (p.props ?? []).filter((pr) => isStructure(pr.kind));
      // Trusses read the way you walk the rig: upstage bars first, then left to
      // right. Unparented fixtures keep their order and land after everything
      // that has a home.
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
            if (!byTruss) return a.address - b.address;
            const ra = a.parentId ? rank.get(a.parentId) ?? 1e6 : 1e6;
            const rb = b.parentId ? rank.get(b.parentId) ?? 1e6 : 1e6;
            if (ra !== rb) return ra - rb;
            if (ra === 1e6) return a.address - b.address;
            return alongOf(a) - alongOf(b);
          });
        for (const f of inU) {
          f.address = addr;
          addr += profileMeta(p, f.profileId)?.channels ?? 1;
        }
      }
    }, 're-address the rig');

  return (
    <div className="rigbar">
      <input
        className="text"
        placeholder="find…"
        title="find a fixture as you type: its name, its profile, its universe, or any address it answers to"
        value={find}
        style={{ width: 140 }}
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setFind(''); }}
      />
      <AddFixture />
      <label
        className="btn small ghost"
        style={{ cursor: 'pointer' }}
        title="import a GDTF fixture definition, or an MVR scene (fixtures, addresses, positions and the definitions inside it). Re-importing a file replaces the stored profile; undo puts the old one back."
      >
        ⇩ import
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
                // and into the library, so the next show starts with it
                if (shareAvailable()) void librarySave(file.name, b64).catch((err) => console.warn('[library]', err));
                return;
              }
              // three explicit choices — replacing everything must never be
              // what Esc or Cancel does
              void askChoice(`Import "${file.name}"`, [
                { value: 'merge', label: 'Merge into the rig', primary: true },
                { value: 'replace', label: 'Replace everything', danger: true },
              ], {
                body:
                  'Merge adds the scene’s fixtures to what is already rigged. Replace clears the fixtures, groups and looks first — undo brings them back.\n\n' +
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
      <button ref={readdr.btnRef} className="btn small ghost" title="pack addresses again — the whole rig, or just what is selected" onClick={readdr.toggle}>
        ⇢ re-address
      </button>
      {readdr.open && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={() => readdr.setOpen(false)} />
          <div ref={readdr.popRef} className="popover" style={{ top: readdr.pos.top, left: readdr.pos.left }}>
            <span className="label">re-address</span>
            {fxSel.length > 0 && (
              <button
                className="btn small ghost"
                title="pack the selected fixtures from a start address you choose, in table order"
                onClick={() => {
                  readdr.setOpen(false);
                  void (async () => {
                    const startStr = await askPrompt(`Re-address ${fxSel.length} selected fixtures`, '1', {
                      body: 'They are packed one after another from this start address, in the order the table shows them.',
                      confirmLabel: 'Re-address',
                    });
                    if (startStr === null) return;
                    const start = Math.max(1, Math.min(512, Number(startStr) || 1));
                    const order = sortFixtures(project, 'address', 'asc');
                    mutate((p) => {
                      let addr = start;
                      for (const f of order) {
                        if (!fxSel.includes(f.id)) continue;
                        const x = p.fixtures.find((y) => y.id === f.id);
                        const ch = profileMeta(p, f.profileId)?.channels ?? 1;
                        if (!x || addr + ch - 1 > 512) continue;
                        x.address = addr;
                        addr += ch;
                      }
                    }, 're-address the selected fixtures');
                  })();
                }}
              >
                the {fxSel.length} selected, from…
              </button>
            )}
            <button
              className="btn small ghost"
              title="re-address every fixture one after another per universe, keeping the order they are in now"
              onClick={() => {
                readdr.setOpen(false);
                void (async () => {
                  if (!(await askConfirm('Re-address every fixture?', {
                    body: 'Fixtures are packed one after another per universe, keeping the order they are in now. Your hardware DIP switches must match afterwards.',
                    confirmLabel: 'Re-address all',
                  }))) return;
                  repack(false);
                })();
              }}
            >
              every fixture, in address order
            </button>
            <button
              className="btn small ghost"
              title="re-address in rigging order: truss by truss, then left to right along each bar"
              onClick={() => {
                readdr.setOpen(false);
                void (async () => {
                  if (!(await askConfirm('Re-address by truss?', {
                    body:
                      'Fixtures are packed per universe in rigging order: truss by truss (upstage first, then left to right), and along each bar left to right. Anything not rigged on a structure keeps its current order and goes last. Your hardware DIP switches must match afterwards.',
                    confirmLabel: 'Re-address by truss',
                  }))) return;
                  repack(true);
                })();
              }}
            >
              every fixture, in rigging order
            </button>
          </div>
        </>
      )}
      <span className="grow" />
      {conflictRows.length > 0 && (
        <span style={{ position: 'relative' }}>
          <button
            className="rigchip bad"
            title="two fixtures on one universe want the same channels — one of them will be driven by the other's look"
            onClick={() => setShowConflicts((v) => !v)}
          >
            {conflictRows.length} address conflict{conflictRows.length > 1 ? 's' : ''} ▾
          </button>
          {showConflicts && (
            <div className="popover" style={{ position: 'absolute', right: 0, top: '100%' }}>
              <span className="label">on these fixtures</span>
              <div className="conflictlist">
                {conflictRows.map((f) => (
                  <button
                    key={f.id}
                    title="select it and scroll the table to it"
                    onClick={() => {
                      useStore.getState().setFxSel([f.id]);
                      setShowConflicts(false);
                    }}
                  >
                    {f.name} · {addressRange(f.address, profileMeta(project, f.profileId)?.channels ?? 1)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </span>
      )}
      {importMsg && (
        <span className="prose" style={{ color: importMsg.ok ? 'var(--good)' : 'var(--hot)' }}>
          {importMsg.text}
        </span>
      )}
    </div>
  );
}

export function FixtureTable({ conflicts }: { conflicts: Set<string> }): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const fxSel = useStore((s) => s.fxSel);
  const find = useRig((s) => s.find);
  const setFind = useRig((s) => s.setFind);
  // Select STABLE keys, not the arrays: snap is freshly parsed 20×/s, so
  // `s.snap?.muted` is a new reference every frame and would re-render this
  // 129-row table 20 times a second the whole time anything is muted.
  const mutedKey = useStore((s) => (s.snap?.muted ?? []).join(','));
  const unknownKey = useStore((s) => (s.snap?.unknownProfiles ?? []).join(','));
  const muted = useMemo(() => (mutedKey ? mutedKey.split(',') : []), [mutedKey]);
  const unknownProfiles = useMemo(() => (unknownKey ? unknownKey.split(',') : []), [unknownKey]);
  const identified = useStore((s) => s.snap?.identify) ?? null;
  const [sortKey, setSortKey] = useState<SortKey>('address');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir('asc');
    }
  };

  /** Fixtures whose profile is a placeholder — an MVR that travelled without
   *  its real fixture definitions. They are not dark, they just have a dimmer
   *  and nothing else, which looks like a bug until you know. */
  const stubProfiles = useMemo(
    () => new Set(Object.entries(project.profiles ?? {}).filter(([, pr]) => isPlaceholderProfile(pr)).map(([id]) => id)),
    [project],
  );
  /** Profiles behind this build's importer: beam channels nothing drives, or a
   *  compiler stamp older than ours. The fixture works, but those controls are
   *  missing from the look editor with no explanation. */
  const beamlessProfiles = useMemo(
    () => new Set(Object.entries(project.profiles ?? {}).filter(([, pr]) => profileNeedsRebuild(pr)).map(([id]) => id)),
    [project],
  );
  // The profile dropdown is identical in every row; built per row it is ~5,000
  // metas per render at 40 profiles × 129 rows. Build the options once.
  const profileOptions = useMemo(
    () => allProfileMetas(project).map((pr) => (
      <option key={pr.id} value={pr.id}>{pr.imported ? '⇩ ' : ''}{pr.label}</option>
    )),
    [project],
  );

  const sorted = useMemo(() => sortFixtures(project, sortKey, sortDir), [project, sortKey, sortDir]);
  const shown = useMemo(
    () => (find.trim() ? sorted.filter((f) => matchesFind(project, f.id, find)) : sorted),
    [sorted, project, find],
  );

  // -- selection: click / ⇧-range / ⌘-toggle / drag-marquee, shared with the
  //    plan through the store's fxSel --
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const anchorRef = useRef<string | null>(null);
  const shownIdsRef = useRef<string[]>([]);
  shownIdsRef.current = shown.map((f) => f.id);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [marqueeHit, setMarqueeHit] = useState<string[]>([]);

  // Selecting on the plan scrolls the table to the row (R3: it used to
  // highlight a row that was three screens down and never move). `nearest`, so
  // clicking a row you can already see never moves the table under your hand.
  const lead = fxSel[0] ?? null;
  useEffect(() => {
    if (!lead) return;
    const row = tbodyRef.current?.querySelector(`tr[data-fxid="${CSS.escape(lead)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [lead]);

  // an unmount mid-drag (a view switch) must not leak the window listeners
  const dragTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragTeardownRef.current?.(), []);

  /** the marquee box clamped to the scrolling section body — rows scrolled out
   *  of view must never be selectable by an overshooting drag */
  const clampBox = (x0: number, y0: number, x1: number, y1: number) => {
    let box = {
      left: Math.min(x0, x1), right: Math.max(x0, x1),
      top: Math.min(y0, y1), bottom: Math.max(y0, y1),
    };
    const c = tbodyRef.current?.closest('.rigsections')?.getBoundingClientRect();
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
    // input — the address cell commits on blur, and hotkeys stay dead while an
    // input keeps focus.
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
        teardown(); // missed pointerup (the window lost focus mid-drag)
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
        const ids = shownIdsRef.current;
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
  // fixtures: typed values set them identically
  const editTargets = (fid: string): string[] => (fxSel.includes(fid) && fxSel.length > 1 ? fxSel : [fid]);
  const eachTarget = (fid: string, fn: (x: Project['fixtures'][number]) => void, label?: string) =>
    mutate((p) => {
      for (const id of editTargets(fid)) {
        const x = p.fixtures.find((y) => y.id === id);
        if (x) fn(x);
      }
    }, label);

  if (project.fixtures.length === 0) {
    return (
      <div className="rigempty">
        no rig yet
        <AddFixture />
        <span className="prose">or ⇩ import a GDTF for one fixture, an MVR for the whole plot</span>
      </div>
    );
  }

  return (
    <>
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
              background: 'var(--color-accent-marquee)',
              border: '1px dashed var(--color-accent-marquee-edge)',
              pointerEvents: 'none',
              zIndex: 30,
            }}
          />
        );
      })()}
      <div onPointerDown={onTablePointerDown}>
        <table className="rigtbl" style={{ minWidth: TABLE_MIN }}>
          <colgroup>
            <col style={{ width: COLS.name }} />
            <col style={{ width: COLS.profile }} />
            <col style={{ width: COLS.universe }} />
            <col style={{ width: COLS.address }} />
            <col style={{ width: COLS.channels }} />
            <col style={{ width: COLS.live }} />
          </colgroup>
          <thead>
            <tr>
              <SortTh k="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>Fixture</SortTh>
              <SortTh k="profile" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>Profile</SortTh>
              <SortTh k="universe" sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="which universe it is plugged into">U</SortTh>
              <SortTh k="address" sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="the channels it answers to, from its start address">Addr</SortTh>
              <SortTh k="channels" sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="how many channels it takes">Ch</SortTh>
              <th title="mute it, or find it on the truss">● ◎</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {shown.map((f) => {
              const prof = profileMeta(project, f.profileId);
              const selected = fxSel.includes(f.id) || marqueeHit.includes(f.id);
              const uniIndex = project.universes.findIndex((u) => u.id === f.universeId) + 1;
              return (
                <tr
                  key={f.id}
                  data-fxid={f.id}
                  className={`${selected ? 'rowsel' : ''} ${unknownProfiles.includes(f.id) ? 'rowdark' : ''} ${stubProfiles.has(f.profileId) ? 'rowstub' : ''} ${beamlessProfiles.has(f.profileId) ? 'rowbeamless' : ''}`}
                  title={
                    unknownProfiles.includes(f.id)
                      ? 'this fixture’s profile is missing — it renders as nothing at all. Re-import the profile or pick another one.'
                      : stubProfiles.has(f.profileId)
                        ? 'placeholder profile: the MVR that brought this fixture in did not carry a real fixture definition, so it has a dimmer and nothing else. Fetch the real one in GDTF Share, then set it here.'
                        : beamlessProfiles.has(f.profileId)
                          ? 'this profile was compiled by an older importer, so the look editor may be missing controls its fixture has — zoom, focus, beam size, soften, warmth, gobo, prism, shutter patterns. Re-import the real GDTF and they appear.'
                          : undefined
                  }
                >
                  <td className="name">
                    <TextField
                      className="text"
                      title="fixture name — what the plan and every group list calls it"
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
                      style={{ width: '100%' }}
                      value={f.profileId}
                      title={editTargets(f.id).length > 1
                        ? `changes the profile on all ${editTargets(f.id).length} selected fixtures`
                        : 'which fixture definition this is'}
                      onChange={(e) => eachTarget(f.id, (x) => { x.profileId = e.target.value; }, 'change the profile')}
                    >
                      {profileOptions}
                    </select>
                  </td>
                  <td>
                    <select
                      className="sel unicell"
                      value={f.universeId}
                      title={`${project.universes.find((u) => u.id === f.universeId)?.label ?? 'universe'}${editTargets(f.id).length > 1 ? ` — moves all ${editTargets(f.id).length} selected fixtures` : ''}`}
                      onChange={(e) => eachTarget(f.id, (x) => { x.universeId = e.target.value; }, 'move to another universe')}
                    >
                      {project.universes.map((u, i) => (
                        <option key={u.id} value={u.id}>{i + 1}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <AddressCell
                      value={f.address}
                      channels={prof?.channels ?? 1}
                      conflict={conflicts.has(f.id)}
                      onCommit={(v) => mutate((p) => {
                        const x = p.fixtures.find((y) => y.id === f.id);
                        if (x) x.address = v;
                      })}
                    />
                  </td>
                  <td className="mono">{prof?.channels ?? '?'}</td>
                  <td>
                    <span className="rowpair">
                      <MuteButton fixtureId={f.id} muted={muted.includes(f.id)} />
                      <FindButton fixtureId={f.id} on={identified === f.id} />
                      <RowMenu fixtureId={f.id} name={f.name} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="rigempty" style={{ marginTop: 8 }}>
            nothing called “{find.trim()}”
            <button className="btn small ghost" title="show every fixture again" onClick={() => setFind('')}>clear find</button>
          </div>
        )}
        <div className="prose" style={{ marginTop: 6 }}>
          Click, ⇧-range or drag a box to select rows; an edit applies to every selected row. The plan
          and this table share one selection.
        </div>
      </div>
    </>
  );
}

/** The row's own verbs: what there is no room for in six columns. */
function RowMenu({ fixtureId, name }: { fixtureId: string; name: string }): React.ReactElement {
  const pop = usePopover();
  const mutate = useStore((s) => s.mutate);
  return (
    <>
      <button ref={pop.btnRef} className="livebtn" title={`what else can be done to ${name}`} onClick={pop.toggle}>⋯</button>
      {pop.open && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={() => pop.setOpen(false)} />
          <div ref={pop.popRef} className="popover" style={{ top: pop.pos.top, left: pop.pos.left }}>
            <span className="label">{name}</span>
            <button
              className="btn small ghost"
              title="duplicate it at the next free address, half a metre across"
              onClick={() => {
                pop.setOpen(false);
                let clone: string | null = null;
                mutate((p) => {
                  const src = p.fixtures.find((x) => x.id === fixtureId);
                  if (!src) return;
                  const ch = profileMeta(p, src.profileId)?.channels ?? 1;
                  const copy = {
                    ...structuredClone(src),
                    id: uid('fx'),
                    name: `${src.name} copy`,
                    address: nextFreeAddress(p, src.universeId, ch),
                    pos: { ...src.pos, x: src.pos.x + 0.3 },
                  };
                  p.fixtures.push(copy);
                  clone = copy.id;
                }, `duplicate ${name}`);
                if (clone) useStore.getState().setFxSel([clone]);
              }}
            >
              ⧉ duplicate
            </button>
            <div className="popover-rule" />
            <button
              className="btn small ghost danger"
              title="delete this fixture — it leaves the rig and every group it is in"
              onClick={() => {
                pop.setOpen(false);
                void (async () => {
                  const ok = await askConfirm(`Delete "${name}"?`, {
                    body: 'It is removed from the rig and from every group.',
                    confirmLabel: 'Delete',
                    danger: true,
                  });
                  if (!ok) return;
                  mutate((p) => {
                    p.fixtures = p.fixtures.filter((x) => x.id !== fixtureId);
                    for (const g of p.groups) g.heads = g.heads.filter((h) => h.fixtureId !== fixtureId);
                  }, `delete ${name}`);
                  const { fxSel: cur, setFxSel } = useStore.getState();
                  if (cur.includes(fixtureId)) setFxSel(cur.filter((i) => i !== fixtureId));
                })();
              }}
            >
              ✕ delete
            </button>
          </div>
        </>
      )}
    </>
  );
}
