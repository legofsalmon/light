// Updates, as the operator sees them.
//
// Notify only, deliberately. Nothing here downloads and nothing installs: the
// panel says a newer build exists and links to it. Installing replaces a
// running, signed, notarised bundle and stops the output to do it, which is a
// decision that belongs nowhere near a screen someone might be looking at
// during a set.
//
// The panel hides itself outside the packaged app, gated in OutputView for the
// same reason the Licence section is — a heading over nothing is worse than no
// heading.

import React, { useEffect, useState } from 'react';
import { mb, updateAvailable, updateCheckNow, updateStatus, type UpdateStatus } from '../update.ts';

export function UpdatePanel(): React.ReactElement | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!updateAvailable()) return;
    updateStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!updateAvailable()) return null;

  const check = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await updateCheckNow());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const found = status?.available ?? null;

  return (
    <div className="col" style={{ gap: 10, maxWidth: 620 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
        running {status?.current ?? '…'}
        {status?.onPrerelease && (
          <span style={{ color: 'var(--text-faint)' }}>
            {' '}· beta channel, so beta builds are offered
          </span>
        )}
      </div>

      {found ? (
        <>
          <div style={{ color: 'var(--good)', fontWeight: 600 }}>
            {found.version.raw} is available{found.prerelease ? ' (beta)' : ''}
            {found.size > 0 && (
              <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · {mb(found.size)}</span>
            )}
          </div>
          <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Download it from the releases page and drag it over the copy in Applications. LIGHT
            does not install updates by itself — replacing the app stops the output, and that is
            not a decision to take while a rig is live.
          </div>
          <div className="row" style={{ gap: 6 }}>
            <a href={found.pageUrl || status?.releasesUrl} target="_blank" rel="noreferrer">
              open the release page
            </a>
          </div>
          {found.notes && (
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--text-dim)' }}>what changed</summary>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  maxHeight: 220,
                  overflowY: 'auto',
                  marginTop: 6,
                }}
              >
                {found.notes}
              </div>
            </details>
          )}
        </>
      ) : (
        <div style={{ color: 'var(--text-dim)' }}>
          {status?.note ? `Last check did not get through — ${status.note}` : 'This is the newest build.'}
        </div>
      )}

      {error && <div style={{ color: 'var(--hot)', lineHeight: 1.5 }}>{error}</div>}

      <div className="row" style={{ gap: 6 }}>
        <button disabled={busy} onClick={check}>
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
    </div>
  );
}
