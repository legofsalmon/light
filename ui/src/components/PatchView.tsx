import React from 'react';
import type { Project } from '../../../shared/types.ts';
import { uid } from '../../../shared/types.ts';
import { PROFILES, PROFILE_LIST } from '../../../shared/profiles.ts';
import { useStore } from '../store.ts';

/** fixture id → true when its address range overlaps another fixture on the same universe */
function findConflicts(p: Project): Set<string> {
  const conflicts = new Set<string>();
  for (const a of p.fixtures) {
    const pa = PROFILES[a.profileId];
    if (!pa) continue;
    if (a.address < 1 || a.address + pa.channels - 1 > 512) {
      conflicts.add(a.id);
      continue;
    }
    for (const b of p.fixtures) {
      if (a.id === b.id || a.universeId !== b.universeId) continue;
      const pb = PROFILES[b.profileId];
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
    .map((f) => [f.address, f.address + (PROFILES[f.profileId]?.channels ?? 1) - 1]);
  for (let a = 1; a + channels - 1 <= 512; a++) {
    if (used.every(([lo, hi]) => a + channels - 1 < lo || a > hi)) return a;
  }
  return 1;
}

export function PatchView() {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const conflicts = findConflicts(project);

  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <div className="sectionhead">Patch</div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Fixture</th><th>Profile</th><th>Universe</th><th>Address</th><th>Ch</th>
              <th>X</th><th>Y</th><th>Z</th><th></th>
            </tr>
          </thead>
          <tbody>
            {project.fixtures.map((f) => {
              const prof = PROFILES[f.profileId];
              return (
                <tr key={f.id}>
                  <td>
                    <input
                      className="text"
                      style={{ width: 130 }}
                      value={f.name}
                      onChange={(e) => mutate((p) => {
                        const x = p.fixtures.find((y) => y.id === f.id);
                        if (x) x.name = e.target.value;
                      })}
                    />
                  </td>
                  <td>
                    <select
                      className="sel"
                      value={f.profileId}
                      onChange={(e) => mutate((p) => {
                        const x = p.fixtures.find((y) => y.id === f.id);
                        if (x) x.profileId = e.target.value;
                      })}
                    >
                      {PROFILE_LIST.map((pr) => (
                        <option key={pr.id} value={pr.id}>{pr.manufacturer} {pr.model} · {pr.mode}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="sel"
                      value={f.universeId}
                      onChange={(e) => mutate((p) => {
                        const x = p.fixtures.find((y) => y.id === f.id);
                        if (x) x.universeId = e.target.value;
                      })}
                    >
                      {project.universes.map((u) => (
                        <option key={u.id} value={u.id}>{u.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className={`num ${conflicts.has(f.id) ? 'conflict' : ''}`}
                      type="number"
                      min={1}
                      max={512}
                      value={f.address}
                      title={conflicts.has(f.id) ? 'address overlap!' : ''}
                      style={conflicts.has(f.id) ? { borderColor: 'var(--hot)', color: 'var(--hot)' } : undefined}
                      onChange={(e) => mutate((p) => {
                        const x = p.fixtures.find((y) => y.id === f.id);
                        if (x) x.address = Math.max(1, Math.min(512, Number(e.target.value) || 1));
                      })}
                    />
                  </td>
                  <td className="mono">{prof?.channels ?? '?'}</td>
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <td key={axis}>
                      <input
                        className="num"
                        style={{ width: 52 }}
                        type="number"
                        step="0.1"
                        value={f.pos[axis]}
                        onChange={(e) => mutate((p) => {
                          const x = p.fixtures.find((y) => y.id === f.id);
                          if (x) x.pos[axis] = Number(e.target.value) || 0;
                        })}
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      className="btn small ghost"
                      onClick={() => mutate((p) => {
                        p.fixtures = p.fixtures.filter((x) => x.id !== f.id);
                        for (const g of p.groups) g.heads = g.heads.filter((h) => h.fixtureId !== f.id);
                      })}
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
          >
            + add fixture
          </button>
          <span className="label">drag fixtures in the 2D previz to place them</span>
        </div>
      </div>

      <div>
        <div className="sectionhead">Groups</div>
        {project.groups.map((g) => (
          <div key={g.id} className="row" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
            <input
              className="text"
              style={{ width: 130 }}
              value={g.name}
              onChange={(e) => mutate((p) => {
                const x = p.groups.find((y) => y.id === g.id);
                if (x) x.name = e.target.value;
              })}
            />
            <div className="grow" style={{ lineHeight: 1.9 }}>
              {project.fixtures.flatMap((f) => {
                const prof = PROFILES[f.profileId];
                if (!prof) return [];
                return prof.heads.map((hd, hi) => {
                  const on = g.heads.some((h) => h.fixtureId === f.id && h.head === hi);
                  const label = prof.heads.length > 1 ? `${f.name}·${hd.label}` : f.name;
                  return (
                    <span
                      key={`${f.id}:${hi}`}
                      className={`headchip ${on ? 'on' : ''}`}
                      onClick={() => mutate((p) => {
                        const x = p.groups.find((y) => y.id === g.id);
                        if (!x) return;
                        const idx = x.heads.findIndex((h) => h.fixtureId === f.id && h.head === hi);
                        if (idx >= 0) x.heads.splice(idx, 1);
                        else x.heads.push({ fixtureId: f.id, head: hi });
                      })}
                    >
                      {label}
                    </span>
                  );
                });
              })}
            </div>
            <button
              className="btn small ghost"
              onClick={() => mutate((p) => {
                p.groups = p.groups.filter((x) => x.id !== g.id);
              })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="btn small"
          onClick={() => mutate((p) => p.groups.push({ id: uid('g'), name: `Group ${p.groups.length + 1}`, heads: [] }))}
        >
          + add group
        </button>
        <div className="label" style={{ marginTop: 6 }}>chip order = chase order (first chip runs first)</div>
      </div>
    </div>
  );
}
