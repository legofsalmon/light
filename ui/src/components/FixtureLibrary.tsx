// The fixture library (backlog #2): everything a fixture can be patched from,
// in one list — the built-in profiles, the generic layouts LIGHT ships, and
// every .gdtf imported or fetched from GDTF Share on this Mac. One search box,
// one "+ rig" per mode. The engine never reads the library: a project carries
// its compiled profiles, so patching a library fixture is `importGdtf` (the
// same compiler the picker's ids came from) and then a fixture row.
//
// Only the LIGHT app has the directory — the bridge is absent in a browser and
// on the tablet — so those get the built-ins and a line saying where the rest
// lives, like GDTF Share.

import React, { useEffect, useMemo, useState } from 'react';
import { PROFILES } from '../../../shared/profiles.ts';
import { askConfirm } from '../dialog.tsx';
import { addFixture } from '../rig.ts';
import { libraryInfo, libraryRead, libraryRemove, shareAvailable, type LibraryEntry } from '../share.ts';
import { useStore } from '../store.ts';

type Row = {
  key: string;
  manufacturer: string;
  model: string;
  mode: string;
  footprint: number;
  heads: number;
  profileId: string;
  /** the library file, or null for a built-in */
  file: string | null;
  seeded: boolean;
  builtin: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function FixtureLibrary(): React.ReactElement {
  const send = useStore((s) => s.send);
  const mutate = useStore((s) => s.mutate);
  const available = shareAvailable();
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    if (!available) return;
    try {
      setEntries(await libraryInfo());
    } catch (e) {
      setNote(String(e));
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => {
    const builtins: Row[] = Object.values(PROFILES).map((b) => ({
      key: b.id, manufacturer: b.manufacturer, model: b.model, mode: b.mode, footprint: b.channels,
      heads: b.heads.length, profileId: b.id, file: null, seeded: false, builtin: true,
    }));
    const lib: Row[] = entries.flatMap((e) =>
      e.modes.map((m) => ({
        key: `${e.file}:${m.profileId}`, manufacturer: e.manufacturer, model: e.model, mode: m.name,
        footprint: m.footprint, heads: m.heads, profileId: m.profileId, file: e.file, seeded: e.seeded, builtin: false,
      })),
    );
    // the operator's own files first, then the generics, then what is compiled in
    const all = [...lib.filter((r) => !r.seeded), ...lib.filter((r) => r.seeded), ...builtins];
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => `${r.manufacturer} ${r.model} ${r.mode}`.toLowerCase().includes(q)) : all;
  }, [entries, query]);
  const unreadable = entries.filter((e) => e.error);

  const add = async (r: Row) => {
    setBusy(r.key);
    setNote(null);
    try {
      if (!r.builtin && r.file) {
        const has = () => !!useStore.getState().project?.profiles?.[r.profileId];
        if (!has()) {
          // the engine compiles the file and echoes the project; the row can
          // only point at the profile once that echo has landed
          send({ type: 'importGdtf', name: r.file, data: await libraryRead(r.file) });
          const t0 = Date.now();
          while (!has()) {
            if (Date.now() - t0 > 6000) throw new Error('the engine did not take the fixture — see the import result above');
            await sleep(100);
          }
        }
      }
      mutate((p) => {
        addFixture(p, r.profileId, r.footprint, r.model);
      }, `add ${r.model}`);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (r: Row) => {
    if (!r.file) return;
    const ok = await askConfirm(`Remove “${r.manufacturer} ${r.model}” from the library?`, {
      body: 'Fixtures already patched keep their profile — the project carries it. Only the file on this Mac goes.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await libraryRemove(r.file);
      await refresh();
    } catch (e) {
      setNote(String(e));
    }
  };

  return (
    <div className="patchsec">
      <div className="sectionhead">Fixture library</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          className="text"
          placeholder="search the library…"
          title="manufacturer, model or mode"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 220 }}
        />
        <span className="label">{rows.length} shown</span>
      </div>
      {!available && (
        <div className="prose" style={{ marginBottom: 8 }}>
          The library on the machine running the show — the files you import or fetch from GDTF Share, and the
          generic layouts LIGHT ships — is only in the LIGHT app. The built-in fixtures are always here.
        </div>
      )}
      {note && <div className="prose" style={{ color: 'var(--hot)', marginBottom: 8 }}>{note}</div>}
      {unreadable.map((e) => (
        <div key={e.file} className="prose" style={{ color: 'var(--warn)', marginBottom: 4 }}>
          {e.file}: {e.error}
        </div>
      ))}
      <table className="tbl">
        <thead>
          <tr>
            <th>Fixture</th><th>Mode</th><th>Ch</th><th>Heads</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.manufacturer} {r.model}
                {r.builtin && (
                  <span className="chip" style={{ marginLeft: 6 }} title="compiled into LIGHT — on every screen, always">
                    built in
                  </span>
                )}
                {r.seeded && (
                  <span className="chip" style={{ marginLeft: 6 }} title="one of LIGHT's own layouts, for a fixture whose channels are simply in this order">
                    generic
                  </span>
                )}
              </td>
              <td className="mono">{r.mode}</td>
              <td className="mono">{r.footprint}</td>
              <td className="mono">{r.heads}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button
                  className="btn small"
                  disabled={busy !== null}
                  title="patch one of these at the next free address on the first universe"
                  onClick={() => void add(r)}
                >
                  {busy === r.key ? '…' : '+ rig'}
                </button>
                {r.file && (
                  <button className="btn small ghost" title="remove this file from the library on this Mac" onClick={() => void remove(r)}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="prose" style={{ marginTop: 6 }}>
        Everything you import or fetch from GDTF Share is kept here, so the next show starts with it. The generics
        are LIGHT's own layouts for fixtures whose channels are simply in order — pick the mode that matches the
        fixture's manual.
      </div>
    </div>
  );
}
