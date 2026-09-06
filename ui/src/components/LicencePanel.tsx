// Licensing, as the operator sees it.
//
// The panel hides itself outside the packaged app: the licence lives in the
// Keychain and the HTTP is in the shell, so a browser or the LAN tablet has no
// way to reach any of it — and no need to, since the gate is applied once at
// startup on the machine running the engine.
//
// Nothing on this screen can stop a show. The only state that costs anything is
// a lapsed trial, and it costs the *next* session, never the one running.

import React, { useEffect, useState } from 'react';
import {
  describe,
  licenceActivate,
  licenceAvailable,
  licenceDeactivate,
  licenceHeartbeat,
  licenceStartTrial,
  licenceStatus,
  type LicenceStatus,
} from '../licence.ts';

const day = 86_400;

/** A deadline as an operator reads it: how long they have, not a timestamp. */
function until(unixSeconds: number): string {
  const left = unixSeconds - Date.now() / 1000;
  if (left <= 0) return 'passed';
  if (left < day) return `${Math.max(1, Math.round(left / 3600))} h`;
  const days = Math.round(left / day);
  return days === 1 ? '1 day' : `${days} days`;
}

const stamp = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const TONE: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--hot)',
};

export function LicencePanel(): React.ReactElement | null {
  const [status, setStatus] = useState<LicenceStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (!licenceAvailable()) return;
    licenceStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!licenceAvailable()) return null;

  const run = async (what: string, fn: () => Promise<LicenceStatus>) => {
    setBusy(what);
    setError('');
    try {
      setStatus(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const said = status ? describe(status) : null;
  const claims = status?.claims ?? null;
  const licensed = status?.status === 'active';

  return (
    <div className="col" style={{ gap: 10, maxWidth: 620 }}>
      {/* No "Licence" heading here — OutputView's sectionhead already says it,
          and printing the word twice is how a panel looks bolted on. */}
      {said && (
        <div style={{ color: TONE[said.tone], fontWeight: 600 }}>{said.title}</div>
      )}

      {said && <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>{said.detail}</div>}

      {status && !status.configured && (
        <div style={{ color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Nothing you can fix from here — the build needs rebuilding once a signing key is set on
          the licence service.
        </div>
      )}

      {claims && (
        <div className="col" style={{ gap: 2, fontFamily: 'var(--mono)', fontSize: 12 }}>
          <div>
            {claims.edition} · {claims.key} · {claims.seats === 1 ? 'one Mac' : `${claims.seats} Macs`}
          </div>
          <div style={{ color: 'var(--text-dim)' }}>
            {claims.edition.toLowerCase() === 'trial' ? 'trial ends' : 'works offline until'}{' '}
            {stamp(claims.exp)} ({until(claims.exp)}) · updates until {stamp(claims.maintUntil)}
          </div>
        </div>
      )}

      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
        this machine: {status?.machine ?? '…'}
      </div>

      {error && <div style={{ color: 'var(--hot)', lineHeight: 1.5 }}>{error}</div>}

      {!licensed && (
        <>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              placeholder="LT-XXXX-XXXX-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              style={{ fontFamily: 'var(--mono)', minWidth: 240 }}
            />
            <button
              disabled={!key.trim() || busy !== ''}
              onClick={() => run('activate', () => licenceActivate(key.trim(), 'LIGHT'))}
            >
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </button>
          </div>

          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <input
              placeholder="your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ minWidth: 140 }}
            />
            <button
              disabled={!email.includes('@') || busy !== ''}
              onClick={() => run('trial', () => licenceStartTrial(email, name))}
            >
              {busy === 'trial' ? 'Starting…' : 'Start trial'}
            </button>
          </div>
        </>
      )}

      <div className="row" style={{ gap: 6 }}>
        <button disabled={busy !== ''} onClick={() => run('heartbeat', licenceHeartbeat)}>
          {busy === 'heartbeat' ? 'Refreshing…' : 'Refresh licence'}
        </button>
        {claims && (
          <button disabled={busy !== ''} onClick={() => run('deactivate', licenceDeactivate)}>
            {busy === 'deactivate' ? 'Deactivating…' : 'Deactivate this Mac'}
          </button>
        )}
      </div>
    </div>
  );
}
