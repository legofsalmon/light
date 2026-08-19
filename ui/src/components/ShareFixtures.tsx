// "Fetch the fixture I'm missing" — GDTF Share, framed as a repair rather than
// a catalogue.
//
// LIGHT already knows which fixtures are dark for want of a profile, and an MVR
// import already records the GDTFSpec of anything it could not resolve. Those
// two facts are the whole feature: put a shortlist beside the problem. The
// alternative — a search UI over the whole catalogue — would mean pulling 12,436
// entries and asking the operator to be a search engine, and Share has no
// server-side search to lean on.
//
// It hides itself entirely outside the packaged app, because the HTTP lives in
// the shell (see ui/src/share.ts).

import React, { useEffect, useState } from 'react';
import type { ShareEntry, ShareList } from '../../../shared/types.ts';
import { parseGdtfSpec, rankMatches } from '../../../shared/gdtfShare.ts';
import { useStore } from '../store.ts';
import {
  shareAvailable,
  shareCatalogue,
  shareDownload,
  shareForget,
  shareLogin,
  shareLoginSaved,
  shareRefresh,
  shareSavedUser,
  shareStatus,
  type ShareStatus,
} from '../share.ts';

const ago = (unixSeconds: number): string => {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

export function ShareFixtures(): React.ReactElement | null {
  const project = useStore((s) => s.project)!;
  const send = useStore((s) => s.send);
  const unknown = useStore((s) => s.snap?.unknownProfiles) ?? [];

  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [catalogue, setCatalogue] = useState<ShareList | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const available = shareAvailable();

  useEffect(() => {
    if (!available) return;
    void (async () => {
      try {
        setStatus(await shareStatus());
        setUser((await shareSavedUser()) ?? '');
        setCatalogue(await shareCatalogue());
      } catch {
        /* the panel simply stays signed-out */
      }
    })();
  }, [available]);

  // Not in a browser, not on the tablet — the shell is where the network is.
  if (!available) return null;

  // The fixtures that are dark for want of a profile. This is the whole reason
  // the panel exists, so when there are none it says so rather than inviting a
  // browse nobody asked for.
  const missing = project.fixtures.filter((f) => unknown.includes(f.id));

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
      setPassword(''); // never keep it in component state longer than the call
      setStatus(await shareStatus());
      setNote('signed in');
    });

  const refresh = () =>
    run('fetching the catalogue', async () => {
      const n = await shareRefresh();
      setCatalogue(await shareCatalogue());
      setStatus(await shareStatus());
      setNote(`${n.toLocaleString()} fixtures available`);
    });

  const download = (entry: ShareEntry, fixtureId: string) =>
    run(`downloading ${entry.fixture}`, async () => {
      const data = await shareDownload(entry);
      // straight into the import path the app already has — no new engine
      // command, no new wire format, no parity risk
      send({ type: 'importGdtf', name: `${entry.fixture}.gdtf`, data });
      setNote(`imported ${entry.manufacturer} ${entry.fixture} — now set it on the fixture`);
      void fixtureId;
    });

  const signedIn = !!status?.user;

  return (
    <div className="patchsec">
      <div className="sechead">GDTF SHARE</div>

      {!signedIn ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="label">
            your own gdtf-share.com account — LIGHT cannot supply one
          </span>
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
          <button
            className="btn small ghost"
            disabled={!!busy}
            title="sign in with the password saved in your Keychain"
            onClick={() =>
              void run('signing in', async () => {
                const u = await shareLoginSaved();
                setUser(u);
                setStatus(await shareStatus());
                setNote('signed in from the Keychain');
              })
            }
          >
            use saved
          </button>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="label">signed in as {status?.user}</span>
          <button className="btn small ghost" disabled={!!busy} onClick={() => void refresh()}>
            refresh catalogue
          </button>
          <span className="label">
            {status && status.cached > 0
              ? `${status.cached.toLocaleString()} fixtures cached${
                  status.cachedAt ? `, ${ago(status.cachedAt)}` : ''
                }`
              : 'catalogue not fetched yet'}
          </span>
          <button
            className="btn small ghost"
            disabled={!!busy}
            title="forget the saved password"
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
      {error && <div className="label" style={{ color: 'var(--bad)' }}>{error}</div>}
      {note && !error && <div className="label">{note}</div>}

      {signedIn && catalogue && (
        <div style={{ marginTop: 8 }}>
          {missing.length === 0 ? (
            <div className="label">
              Nothing is missing a profile. This panel fills itself in when a fixture
              is dark for want of one — after an MVR import, usually.
            </div>
          ) : (
            missing.map((f) => {
              const want = parseGdtfSpec(f.profileId.replace(/^gdtf-/, ''));
              const matches = rankMatches(
                want.model ? want : { model: f.name },
                catalogue.list,
                5,
              );
              return (
                <div key={f.id} style={{ marginBottom: 10 }}>
                  <div className="label">
                    <b>{f.name}</b> — no profile for <code>{f.profileId}</code>
                  </div>
                  {matches.length === 0 ? (
                    <div className="label">nothing on Share looks like this one</div>
                  ) : (
                    matches.map((m) => (
                      <div
                        key={m.entry.rid}
                        className="row"
                        style={{ gap: 6, alignItems: 'center' }}
                      >
                        <button
                          className="btn small"
                          disabled={!!busy}
                          onClick={() => void download(m.entry, f.id)}
                        >
                          get
                        </button>
                        <span>
                          {m.entry.manufacturer} · {m.entry.fixture}
                        </span>
                        <span className="label">
                          GDTF {m.entry.version} · {m.entry.modes.length} mode
                          {m.entry.modes.length === 1 ? '' : 's'} ·{' '}
                          {Math.round(m.entry.filesize / 1024)} KB
                          {m.entry.creator ? ` · ${m.entry.creator}` : ''}
                          {m.entry.rating ? ` · ★ ${m.entry.rating}` : ''}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
