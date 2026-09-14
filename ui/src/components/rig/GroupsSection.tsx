// Groups: the sets of heads looks point at, in chase order.
//
// Members only (design 2.9). The old row printed one chip per head in the rig
// per group — 525 chips on the owner's rig, of which seven were members — so
// the one thing a group row is for, "who is in this and in what order", was the
// thing you could not see. Adding is a picker and a verb now, not a haystack.

import React, { useMemo, useState } from 'react';
import { Glyph } from '../../glyphs.tsx';
import type { HeadRef } from '../../../../shared/types.ts';
import { uid } from '../../../../shared/types.ts';
import { applyAutoGroups, planAutoGroups } from '../../autoGroups.ts';
import { askConfirm } from '../../dialog.tsx';
import { profileMeta } from '../../profileInfo.ts';
import { useStore } from '../../store.ts';
import { TextField } from '../inputs.tsx';
import { usePopover } from './parts.tsx';

export function GroupsSection(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const fxSel = useStore((s) => s.fxSel);

  /** head → the words a person reads for it */
  const headLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of project.fixtures) {
      const prof = profileMeta(project, f.profileId);
      if (!prof) continue;
      prof.heads.forEach((hd, hi) => {
        m.set(`${f.id}:${hi}`, prof.heads.length > 1 ? `${f.name}·${hd.label}` : f.name);
      });
    }
    return m;
  }, [project]);

  const addSelected = (groupId: string) => {
    const heads: HeadRef[] = fxSel.flatMap((fid) => {
      const f = project.fixtures.find((x) => x.id === fid);
      const prof = f && profileMeta(project, f.profileId);
      return prof ? prof.heads.map((_, hi) => ({ fixtureId: fid, head: hi })) : [];
    });
    if (heads.length === 0) return;
    mutate((p) => {
      const g = p.groups.find((x) => x.id === groupId);
      if (!g) return;
      for (const h of heads) {
        if (!g.heads.some((x) => x.fixtureId === h.fixtureId && x.head === h.head)) g.heads.push(h);
      }
      delete g.auto; // edited membership = promoted to authored
    }, 'add heads to a group');
  };

  return (
    <>
      <div className="sectionhead" data-setup="groups">
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
        {fxSel.length > 0 && project.groups.length > 0 && (
          <select
            className="sel"
            style={{ marginLeft: 10 }}
            value=""
            title="add every head of the selected fixtures to a group, at the end of its chase order"
            onChange={(e) => {
              if (e.target.value) addSelected(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">add {fxSel.length} selected to ▾</option>
            {project.groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}
      </div>

      {project.groups.length === 0 && (
        <div className="rigempty">
          no groups yet
          <button
            className="btn small"
            title="a named set of heads. Groups are what looks point at, and their order is chase order."
            onClick={() => mutate((p) => p.groups.push({ id: uid('g'), name: `Group ${p.groups.length + 1}`, heads: [] }))}
          >
            + add group
          </button>
        </div>
      )}

      {project.groups.map((g) => (
        <div key={g.id} className="grouprow">
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
              delete x.auto; // renamed = promoted to authored
            })}
          />
          {g.auto !== undefined && (
            <span
              className="chip"
              title="derived group — ⟳ may rewrite it; click to pin it as yours (renaming or editing also does)"
              style={{ cursor: 'pointer' }}
              onClick={() => mutate((p) => {
                const x = p.groups.find((y) => y.id === g.id);
                if (x) delete x.auto;
              })}
            >
              auto
            </span>
          )}
          <div className="groupmembers">
            {g.heads.length === 0 && <span className="prose">no heads yet</span>}
            {g.heads.map((h, i) => (
              <span
                key={`${h.fixtureId}:${h.head}:${i}`}
                className="headchip on"
                role="button"
                tabIndex={0}
                title={`${i + 1} in the chase — click to take it out of this group`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                onClick={() => mutate((p) => {
                  const x = p.groups.find((y) => y.id === g.id);
                  if (!x) return;
                  x.heads.splice(i, 1);
                  delete x.auto;
                }, 'take a head out of a group')}
              >
                {i + 1}· {headLabel.get(`${h.fixtureId}:${h.head}`) ?? 'missing fixture'}
              </span>
            ))}
            <AddHeads groupId={g.id} />
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
                const users = Object.values(project.looks).filter((lk) => lk.parts.some((pt) => pt.groupId === g.id));
                if (users.length > 0) {
                  const ok = await askConfirm(`Delete group "${g.name}"?`, {
                    body: `${users.length} look(s) point at it: ${users.map((l) => l.name).join(', ')}. Those parts stop rendering until you point them at another group.`,
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
            <Glyph name="clear" alone />
          </button>
        </div>
      ))}

      {project.groups.length > 0 && (
        <button
          className="btn small"
          style={{ marginTop: 8 }}
          title="a named set of heads. Groups are what looks point at, and their order is chase order."
          onClick={() => mutate((p) => p.groups.push({ id: uid('g'), name: `Group ${p.groups.length + 1}`, heads: [] }))}
        >
          + add group
        </button>
      )}
      <div className="prose" style={{ marginTop: 6 }}>Chip order is chase order — the first chip runs first.</div>
    </>
  );
}

/** `+ heads…`: the fixtures this group does not hold yet, found by name.
 *  Clicking one adds every head it has, in the profile's own order — which is
 *  the chase order for a bar, and the only order that means anything for a
 *  fixture with one head. */
function AddHeads({ groupId }: { groupId: string }): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const pop = usePopover();
  const [query, setQuery] = useState('');
  const group = project.groups.find((g) => g.id === groupId);
  const q = query.trim().toLowerCase();
  const rows = project.fixtures
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .map((f) => {
      const prof = profileMeta(project, f.profileId);
      const heads = prof?.heads.length ?? 0;
      const inGroup = (group?.heads ?? []).filter((h) => h.fixtureId === f.id).length;
      return { f, heads, inGroup };
    })
    .filter((r) => r.heads > r.inGroup);

  return (
    <>
      <button ref={pop.btnRef} className="btn small ghost" title="add heads to this group" onClick={pop.toggle}>
        + heads…
      </button>
      {pop.open && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={() => pop.setOpen(false)} />
          <div ref={pop.popRef} className="popover" style={{ top: pop.pos.top, left: pop.pos.left, maxHeight: '50vh', overflow: 'auto' }}>
            <input
              className="text"
              placeholder="find a fixture…"
              title="by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {rows.length === 0 && <span className="label dim">every fixture is already in this group</span>}
            {rows.slice(0, 60).map(({ f, heads, inGroup }) => (
              <button
                key={f.id}
                className="btn small ghost"
                title={heads > 1 ? `add all ${heads - inGroup} of its heads, in the order the fixture lays them out` : 'add it to this group'}
                onClick={() => mutate((p) => {
                  const g = p.groups.find((x) => x.id === groupId);
                  const prof = profileMeta(p, f.profileId);
                  if (!g || !prof) return;
                  prof.heads.forEach((_, hi) => {
                    if (!g.heads.some((h) => h.fixtureId === f.id && h.head === hi)) g.heads.push({ fixtureId: f.id, head: hi });
                  });
                  delete g.auto;
                }, `add ${f.name} to a group`)}
              >
                {f.name}{heads > 1 ? ` · ${heads - inGroup} heads` : ''}
              </button>
            ))}
            {rows.length > 60 && <span className="label dim">{rows.length - 60} more — keep typing</span>}
          </div>
        </>
      )}
    </>
  );
}
