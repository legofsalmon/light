// The profiles this show carries, and what they are used by.
//
// A project stores its compiled profiles so a show opens on a machine that has
// never seen the fixture. The cost is that they accumulate: every import and
// every re-import left one behind, and there was no way to remove any of them.
//
// The names are editable because imported ones are often unreadable
// ("ACME LYRA(XA 1000 BSWF IP)") and the name is what every fixture dropdown in
// the Rig view shows. Renaming touches metadata only — the channels, and
// therefore every byte on the wire, are untouched.

import React from 'react';
import { askConfirm } from '../../dialog.tsx';
import { useStore } from '../../store.ts';
import { PixelLayout } from '../PixelLayout.tsx';
import { TextField } from '../inputs.tsx';

export function ProfilesSection(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const entries = Object.entries(project.profiles ?? {}).sort(([, a], [, b]) =>
    `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`));

  const usedBy = (id: string) => project.fixtures.filter((f) => f.profileId === id).length;
  const editMeta = (id: string, key: 'manufacturer' | 'model' | 'mode', v: string) =>
    mutate((p) => {
      const prof = p.profiles?.[id];
      if (prof) prof[key] = v;
    }, `rename profile ${v}`);

  return (
    <>
      <div className="sectionhead" data-setup="profiles">Profiles</div>
      {entries.length === 0 ? (
        <div className="rigempty">no imported profiles — the built-in fixtures are always here</div>
      ) : (
        <>
          <div className="prose" style={{ marginBottom: 6 }}>
            Compiled from the fixture definitions this show has imported, and carried inside it so it opens
            anywhere. Renaming changes what the Rig view calls them and nothing else.
          </div>
          <table className="rigtbl">
            <thead>
              <tr>
                <th>Manufacturer</th><th>Model</th><th>Mode</th>
                <th title="how many DMX channels one of these takes">Channels</th>
                <th title="how many emitters the definition describes">Heads</th>
                <th title="fixtures in this show pointing at it">Used by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([id, prof]) => {
                const n = usedBy(id);
                return (
                  <tr key={id}>
                    <td>
                      <TextField
                        className="text" style={{ width: '100%' }} entityId={`${id}-man`} value={prof.manufacturer}
                        title="who makes it — for reading, never sent anywhere"
                        onCommit={(v) => editMeta(id, 'manufacturer', v)}
                      />
                    </td>
                    <td>
                      <TextField
                        className="text" style={{ width: '100%' }} entityId={`${id}-mod`} value={prof.model}
                        title="the fixture's name — for reading, never sent anywhere"
                        onCommit={(v) => editMeta(id, 'model', v)}
                      />
                    </td>
                    <td>
                      <TextField
                        className="text" style={{ width: '100%' }} entityId={`${id}-mode`} value={prof.mode}
                        title="which DMX mode of the fixture this is"
                        onCommit={(v) => editMeta(id, 'mode', v)}
                      />
                    </td>
                    <td><span className="label mono">{prof.footprint}</span></td>
                    <td><span className="label mono">{prof.heads.length}</span></td>
                    <td><span className={`label ${n === 0 ? 'dim' : ''}`}>{n === 0 ? 'nothing' : n}</span></td>
                    <td>
                      <button
                        className="btn small ghost"
                        disabled={n > 0}
                        title={n > 0
                          ? `${n} fixture${n === 1 ? '' : 's'} still use this — point them at another profile first, or they would render as nothing at all`
                          : 'remove this profile from the show. The .gdtf it came from stays in the fixture library, so it can be imported again.'}
                        onClick={() => {
                          void askConfirm(`Remove ${prof.manufacturer} ${prof.model}?`, {
                            body: 'Nothing in this show uses it. The file it came from stays in the fixture library, so it can be imported again — and undo brings it back either way.',
                            confirmLabel: 'Remove',
                            danger: true,
                          }).then((ok) => {
                            if (!ok) return;
                            mutate((p) => {
                              if (p.profiles) delete p.profiles[id];
                            }, `remove profile ${prof.model}`);
                          });
                        }}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <PixelLayout />
    </>
  );
}
