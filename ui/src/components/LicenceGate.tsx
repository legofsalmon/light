// The first thing anyone sees on a copy with no usable licence.
//
// This exists because of a flaw worth naming: the gate used to fire only on a
// LAPSED trial, and a copy that had never started one ran forever. So starting
// a trial was strictly worse than ignoring it — the honest user got three days
// and everyone else got unlimited. The trial has to be the way IN, not a
// countdown you opt into.
//
// It replaces the console entirely rather than sitting over it, because when
// this shows the engine was never started: there is no show behind it to see,
// and a console reporting "engine not responding" would be a worse lie than a
// licence screen.
//
// Nothing here can interrupt a running show. The gate is decided once, in
// main.rs, before the engine thread exists.

import React, { useEffect, useState } from 'react';
import {
  describe,
  licenceActivate,
  licenceAvailable,
  licenceRelaunch,
  licenceStartTrial,
  licenceStatus,
  type LicenceStatus,
} from '../licence.ts';
import { openExternal } from '../shell.ts';

export function LicenceGate({ onCleared }: { onCleared?: () => void }): React.ReactElement | null {
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
      const next = await fn();
      setStatus(next);
      if (!next.blocksNewSession) {
        // The engine was never started, so a relaunch is the honest way to get
        // one. Nothing is in memory to lose — unlike the update path, where
        // restarting would skip the project flush.
        onCleared?.();
        await licenceRelaunch();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const said = status ? describe(status) : null;
  const wrongMachine = status?.status === 'wrong_machine';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        zIndex: 9999,
        padding: 24,
        overflowY: 'auto',
      }}
    >
      <div className="col" style={{ gap: 18, width: 'min(520px, 100%)' }}>
        <div className="col" style={{ gap: 6 }}>
          <div className="wordmark" style={{ fontSize: 22 }}>LIGHT</div>
          {said && (
            <div style={{ color: said.tone === 'bad' ? 'var(--hot)' : 'var(--warn)', fontWeight: 600 }}>
              {said.title}
            </div>
          )}
          {said && <div style={{ color: 'var(--text-dim)', lineHeight: 1.6 }}>{said.detail}</div>}
        </div>

        {wrongMachine ? (
          // No second paragraph here: describe() above already says to release
          // the other seat, and saying it twice is how a screen reads as
          // assembled rather than written.
          <button className="btn on" style={{ alignSelf: 'flex-start' }} onClick={() => openExternal(status?.manageUrl)}>
            manage your licences →
          </button>
        ) : (
          <div className="col" style={{ gap: 8 }}>
            <div className="sectionhead">Start a trial</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <input
                className="text"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ minWidth: 220, flex: 1 }}
              />
              <input
                className="text"
                placeholder="your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ minWidth: 140 }}
              />
            </div>
            <button
              className="btn on"
              style={{ alignSelf: 'flex-start' }}
              disabled={!email.includes('@') || busy !== ''}
              onClick={() => run('trial', () => licenceStartTrial(email, name))}
            >
              {busy === 'trial' ? 'Starting…' : 'Start the trial'}
            </button>
          </div>
        )}

        <div className="col" style={{ gap: 8 }}>
          <div className="sectionhead">Or enter a licence key</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input
              className="text"
              placeholder="LT-XXXX-XXXX-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              style={{ fontFamily: 'var(--mono)', minWidth: 260, flex: 1 }}
            />
            <button
              className="btn"
              disabled={!key.trim() || busy !== ''}
              onClick={() => run('activate', () => licenceActivate(key.trim(), 'LIGHT'))}
            >
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </button>
          </div>
        </div>

        {error && <div style={{ color: 'var(--hot)', lineHeight: 1.6 }}>{error}</div>}

        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
          this machine: {status?.machine ?? '…'}
        </div>
        <div style={{ color: 'var(--text-faint)', fontSize: 12, lineHeight: 1.6 }}>
          Starting a trial or activating needs an internet connection. Once it is done LIGHT works
          offline — the licence is checked against a copy on this machine, not the network.
        </div>
      </div>
    </div>
  );
}
