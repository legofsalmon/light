// `+ add fixture…` — the four things you know when you patch something, asked
// together (design 2.9, item 7): what it is, how many, which universe, and
// where the first one starts. The new rows are selected, so the next thing you
// do — name them, drag them onto the plan, group them — already has them.
//
// What it replaces: a button that dropped one generic 3-channel par at (0, 2, 0)
// and a library three screens further down.

import React, { useState } from 'react';
import { PROFILES } from '../../../../shared/profiles.ts';
import { addressRange, addFixtures, nextFreeAddress } from '../../rig.ts';
import { allProfileMetas } from '../../profileInfo.ts';
import { useStore } from '../../store.ts';
import { usePopover } from './parts.tsx';

export function AddFixture(): React.ReactElement {
  const project = useStore((s) => s.project)!;
  const mutate = useStore((s) => s.mutate);
  const pop = usePopover();
  const metas = allProfileMetas(project);
  const [profileId, setProfileId] = useState(metas[0]?.id ?? '');
  const [count, setCount] = useState(1);
  const [universeId, setUniverseId] = useState(project.universes[0]?.id ?? 'u1');
  /** null = follow the next free address; a number = what was typed */
  const [address, setAddress] = useState<number | null>(null);

  const meta = metas.find((m) => m.id === profileId) ?? metas[0];
  const channels = meta?.channels ?? 1;
  /** What the new fixtures are called: the model on its own. The dropdown's
   *  label carries the manufacturer and the mode so you can tell two modes of
   *  one fixture apart; on the truss it is "Spiider 3". */
  const model = meta
    ? project.profiles?.[meta.id]?.model ?? PROFILES[meta.id]?.model ?? meta.label
    : '';
  const start = address ?? nextFreeAddress(project, universeId, channels);
  const fit = Math.max(0, Math.min(count, Math.floor((513 - start) / channels)));

  const add = () => {
    if (!meta) return;
    let ids: string[] = [];
    mutate((p) => {
      ids = addFixtures(p, {
        profileId: meta.id,
        model,
        channels,
        count,
        universeId,
        address: start,
      });
    }, count > 1 ? `add ${count} fixtures` : `add ${model}`);
    if (ids.length) useStore.getState().setFxSel(ids);
    pop.setOpen(false);
    setAddress(null);
  };

  return (
    <>
      <button
        ref={pop.btnRef}
        className="btn small"
        title="patch a run of fixtures: the type, how many, which universe and where the first one starts"
        onClick={pop.toggle}
      >
        + add fixture…
      </button>
      {pop.open && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={() => pop.setOpen(false)} />
          <div ref={pop.popRef} className="popover" style={{ top: pop.pos.top, left: pop.pos.left }}>
            <span className="label">add fixtures</span>
            <select
              className="sel"
              value={profileId}
              title="which fixture definition to patch. Anything not here is in the Library section, or imported from a GDTF."
              onChange={(e) => { setProfileId(e.target.value); setAddress(null); }}
            >
              {metas.map((m) => (
                <option key={m.id} value={m.id}>{m.imported ? '⇩ ' : ''}{m.label}</option>
              ))}
            </select>
            <div className="inspectfield">
              <span className="label">how many</span>
              <input
                className="num"
                type="number"
                min={1}
                max={128}
                value={count}
                title="how many of them, addressed one after another"
                onChange={(e) => setCount(Math.max(1, Math.min(128, Number(e.target.value) || 1)))}
              />
            </div>
            <div className="inspectfield">
              <span className="label">universe</span>
              <select
                className="sel"
                value={universeId}
                title="which universe they are plugged into"
                onChange={(e) => { setUniverseId(e.target.value); setAddress(null); }}
              >
                {project.universes.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
            </div>
            <div className="inspectfield">
              <span className="label">start at</span>
              <input
                className="num"
                type="number"
                min={1}
                max={512}
                value={start}
                title="the first one's start address; the rest follow on. Left alone, it is the next free address on that universe."
                onChange={(e) => setAddress(Math.max(1, Math.min(512, Number(e.target.value) || 1)))}
              />
              {address !== null && (
                <button className="btn small ghost" title="back to the next free address on that universe" onClick={() => setAddress(null)}>
                  next free
                </button>
              )}
            </div>
            <span className="label dim mono">
              {fit > 0 ? `${fit} × ${channels} ch · ${addressRange(start, fit * channels)}` : 'no room on this universe'}
            </span>
            {fit < count && (
              <span className="label" style={{ color: 'var(--warn)' }}>
                only {fit} fit before channel 512 — the rest are not patched
              </span>
            )}
            <div className="popover-rule" />
            <button className="btn small" disabled={fit === 0} title="patch them and select the new rows" onClick={add}>
              add {fit > 1 ? `${fit} fixtures` : 'the fixture'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
