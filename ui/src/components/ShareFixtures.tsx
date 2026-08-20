// GDTF Share — fetching a fixture definition the show does not have.
//
// Two ways in. The repair path: LIGHT already knows which fixtures are dark for
// want of a profile, so a shortlist goes beside the problem. And free-text
// search, because a well-formed MVR resolves everything — a real festival scene
// imported here with all 129 fixtures matched and nothing dark — so a
// repair-only panel would be unreachable on a healthy show, which is most of
// them.
//
// The catalogue is 6.4 MB and 12,437 entries and it only grows. It is never
// shipped to this window: the shell does a coarse substring pass on the file it
// already has, and only the survivors cross the IPC bridge. Ranking then happens
// here, in one tested place (shared/gdtfShare.ts), because ranking is what makes
// the shortlist good and it is far too easy to get subtly wrong twice.
//
// The whole panel hides itself outside the packaged app: the HTTP lives in the
// shell, so a browser or the LAN tablet has no way to reach it.

import React, { useEffect, useState } from 'react';
import type { ShareEntry } from '../../../shared/types.ts';
import { hasUndrivenBeamChannels, isPlaceholderProfile, parseGdtfSpec, rankMatches } from '../../../shared/gdtfShare.ts';
import { useStore } from '../store.ts';
import {
  shareAvailable,
  shareCachedCount,
  shareDownload,
  shareForget,
  libraryList,
  libraryRead,
  shareLogin,
  shareLoginSaved,
  shareRefresh,
  shareSavedUser,
  shareSearch,
  shareStatus,
  type ShareStatus,
} from '../share.ts';

const ago = (unixSeconds: number): string => {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

/** One result row — the same shape whether it came from a search or a repair. */
function Result({
  entry,
  busy,
  onGet,
}: {
  entry: ShareEntry;
  busy: boolean;
  onGet: () => void;
}): React.ReactElement {
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
      <button className="btn small" disabled={busy} onClick={onGet}>
        get
      </button>
      <span>
        {entry.manufacturer} · {entry.fixture}
      </span>
      <span className="label">
        GDTF {entry.version} · {entry.modes.length} mode{entry.modes.length === 1 ? '' : 's'} ·{' '}
        {Math.round(entry.filesize / 1024)} KB
        {entry.creator ? ` · ${entry.creator}` : ''}
        {entry.rating ? ` · ★ ${entry.rating}` : ''}
      </span>
    </div>
  );
}

export function ShareFixtures(): React.ReactElement | null {
  const project = useStore((s) => s.project)!;
  const send = useStore((s) => s.send);
  const unknown = useStore((s) => s.snap?.unknownProfiles) ?? [];

  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [cached, setCached] = useState(0);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ShareEntry[]>([]);
  const [repairs, setRepairs] = useState<Record<string, ShareEntry[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const available = shareAvailable();
  const signedIn = !!status?.user;

  // Profiles compiled by an older build keep whatever the compiler understood
  // then — a Spiider patched before LIGHT could drive zoom has a Zoom channel
  // with nothing behind it, and the fader would silently do nothing. The source
  // .gdtf is still in the library, so this is offered as a rebuild rather than
  // asking the operator to hunt the file down and import it again.
  const stale = Object.entries(project.profiles ?? {})
    .filter(([, pr]) => hasUndrivenBeamChannels(pr))
    .map(([id]) => id);

  // Sign in from the Keychain without being asked. "Remember me" that still
  // makes you press a button every launch is barely remembering anything — and
  // a silent failure here is fine, because the sign-in form is right there.
  useEffect(() => {
    if (!available) return;
    void (async () => {
      try {
        const [st, saved, n] = await Promise.all([
          shareStatus(),
          shareSavedUser(),
          shareCachedCount(),
        ]);
        setUser(saved ?? '');
        setCached(n);
        if (!st.user && saved) {
          try {
            const who = await shareLoginSaved();
            setStatus(await shareStatus());
            setNote(`signed in as ${who}`);
            return;
          } catch {
            // Keychain entry gone, password changed, or no network at the
            // venue — fall through to the form rather than shouting on open
          }
        }
        setStatus(st);
      } catch {
        /* the panel simply stays signed-out */
      }
    })();
  }, [available]);

  // Two kinds of broken. A fixture with NO profile renders as nothing; a fixture
  // with a PLACEHOLDER profile renders as a dimmer and nothing else, which is
  // what an MVR exported without its real fixture definitions leaves behind —
  // and is far harder to notice, because it looks like the app cannot drive
  // your movers. Both want the same answer: fetch the real definition.
  const stubIds = new Set(
    Object.entries(project.profiles ?? {})
      .filter(([, pr]) => isPlaceholderProfile(pr))
      .map(([id]) => id),
  );
  // one row per broken PROFILE, not per fixture: 24 Spiiders share one problem
  const broken = [...new Map(
    project.fixtures
      .filter((f) => unknown.includes(f.id) || stubIds.has(f.profileId))
      .map((f) => [f.profileId, f]),
  ).values()];
  const missing = broken;
  const missingKey = broken.map((f) => f.profileId).join(',');

  // Candidates for whatever is dark. Keyed on which fixtures are missing, so it
  // does not re-run on every snapshot.
  useEffect(() => {
    if (!signedIn || cached === 0 || missingKey === '') {
      setRepairs({});
      return;
    }
    void (async () => {
      const next: Record<string, ShareEntry[]> = {};
      for (const f of broken) {
        const want = parseGdtfSpec(f.profileId.replace(/^gdtf-/, ''));
        const q = want.model ?? f.name;
        try {
          // rankMatches returns {entry, score}; the repair list only needs the
          // entries, and the score has already done its job by ordering them
          next[f.id] = rankMatches(want.model ? want : { model: f.name }, await shareSearch(q), 5)
            .map((m) => m.entry);
        } catch {
          next[f.id] = [];
        }
      }
      setRepairs(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, cached, missingKey]);

  // Search, debounced — every keystroke otherwise re-reads a 6.4 MB file.
  useEffect(() => {
    const q = query.trim();
    if (!signedIn || q.length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void shareSearch(q)
        .then(setHits)
        .catch(() => setHits([]));
    }, 220);
    return () => clearTimeout(t);
  }, [query, signedIn]);

  if (!available) return null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const signIn = () =>
    run('signing in', async () => {
      await shareLogin(user.trim(), password, remember);
      setPassword(''); // out of component state the moment it is not needed
      setStatus(await shareStatus());
      setNote('signed in');
    });

  const refresh = () =>
    run('fetching the catalogue', async () => {
      const n = await shareRefresh();
      setCached(n);
      setStatus(await shareStatus());
      setNote(`${n.toLocaleString()} fixtures available`);
    });

  const download = (entry: ShareEntry) =>
    run(`downloading ${entry.fixture}`, async () => {
      const data = await shareDownload(entry);
      // straight into the import path the app already has — no new engine
      // command, no new wire format, no parity risk
      send({
        type: 'importGdtf',
        name: `${entry.fixture}.gdtf`,
        data,
        // GDTF Share asks that authors be acknowledged, and a compiled profile
        // ends up inside a project file that travels to the gig — so the credit
        // has to travel with it. The catalogue is the only place that knows it.
        credit: [entry.creator, entry.uploader === 'Manuf.' ? 'manufacturer' : null]
          .filter(Boolean)
          .join(' · ') || undefined,
      });
      setNote(`imported ${entry.manufacturer} ${entry.fixture} — set it on the fixture in the patch`);
    });

  const ranked = query.trim().length >= 2 ? rankMatches({ model: query.trim() }, hits, 8) : [];

  return (
    <div className="patchsec">
      <div className="sechead">GDTF SHARE</div>

      {stale.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          <span className="label">
            {stale.length} profile{stale.length === 1 ? '' : 's'} predate the beam
            parameters — zoom, focus, iris and frost are patched but not driven
          </span>
          <button
            className="btn small"
            disabled={!!busy}
            title="re-import every .gdtf in the local fixture library"
            onClick={() =>
              void run('rebuilding profiles', async () => {
                const files = await libraryList();
                if (files.length === 0) {
                  setNote('the local fixture library is empty — re-download the fixture from Share');
                  return;
                }
                // the same import the app already runs after a Share download,
                // so this adds nothing to the wire protocol
                for (const name of files) {
                  send({ type: 'importGdtf', name, data: await libraryRead(name) });
                }
                setNote(
                  `rebuilt from ${files.length} library file${files.length === 1 ? '' : 's'} — ` +
                    'fixtures using them can now take the beam parameters',
                );
              })
            }
          >
            rebuild from library
          </button>
        </div>
      )}

      {!signedIn ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="label">your own gdtf-share.com account — LIGHT cannot supply one</span>
          <input
            className="text"
            style={{ width: 150 }}
            placeholder="username"
            autoComplete="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
          <input
            className="text"
            style={{ width: 150 }}
            type="password"
            placeholder="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && user.trim() && password) void signIn();
            }}
          />
          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            remember me
          </label>
          <button
            className="btn small"
            disabled={!!busy || !user.trim() || !password}
            onClick={() => void signIn()}
          >
            sign in
          </button>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="label">signed in as {status?.user}</span>
          <button className="btn small ghost" disabled={!!busy} onClick={() => void refresh()}>
            refresh catalogue
          </button>
          <span className="label">
            {cached > 0
              ? `${cached.toLocaleString()} fixtures cached${
                  status?.cachedAt ? `, ${ago(status.cachedAt)}` : ''
                }`
              : 'catalogue not fetched yet — press refresh'}
          </span>
          <button
            className="btn small ghost"
            disabled={!!busy}
            title="forget the saved password and sign out"
            onClick={() =>
              void run('forgetting', async () => {
                await shareForget();
                setStatus(await shareStatus());
                setNote('saved sign-in cleared');
              })
            }
          >
            forget me
          </button>
        </div>
      )}

      {busy && <div className="label">{busy}…</div>}
      {error && (
        <div className="label" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}
      {note && !error && <div className="label">{note}</div>}

      {signedIn && (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <input
              className="text"
              style={{ width: 240 }}
              placeholder={
                cached > 0 ? 'search fixtures — e.g. mac aura, sharpy' : 'refresh the catalogue first'
              }
              disabled={cached === 0}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() && (
              <button className="btn small ghost" onClick={() => setQuery('')}>
                clear
              </button>
            )}
          </div>

          {query.trim().length >= 2 &&
            (ranked.length === 0 ? (
              <div className="label">nothing matches</div>
            ) : (
              <div style={{ marginBottom: 10 }}>
                {ranked.map((m) => (
                  <Result
                    key={m.entry.rid}
                    entry={m.entry}
                    busy={!!busy}
                    onGet={() => void download(m.entry)}
                  />
                ))}
              </div>
            ))}

          {missing.map((f) => (
            <div key={f.id} style={{ marginBottom: 10 }}>
              <div className="label">
                <b>{f.name}</b>
                {stubIds.has(f.profileId) ? (
                  <>
                    {' '}— placeholder profile: this MVR travelled without a real
                    fixture definition, so it has a dimmer and nothing else
                  </>
                ) : (
                  <>
                    {' '}— no profile for <code>{f.profileId}</code>
                  </>
                )}
              </div>
              {(repairs[f.id] ?? []).length === 0 ? (
                <div className="label">nothing on Share looks like this one</div>
              ) : (
                repairs[f.id].map((m) => (
                  <Result key={m.rid} entry={m} busy={!!busy} onGet={() => void download(m)} />
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
