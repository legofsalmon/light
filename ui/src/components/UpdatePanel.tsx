// Updates, as the operator sees them.
//
// Three rules this screen exists to keep:
//
// 1. **Nothing happens without a press.** No background download, no
//    install-on-quit, no countdown. The check is the only automatic part.
// 2. **Installing is armed, not a button.** It quits LIGHT and stops the
//    output. That is a two-press decision, like Escape-to-quit, and the second
//    press says exactly what it will do.
// 3. **Refusals are sentences, not greyed-out buttons.** "The rig is lit" tells
//    you what to do; a disabled button with no explanation is the worst of
//    both.
//
// The panel hides itself outside the packaged app, gated in OutputView. That is
// not tidiness: a tablet pressing install would quit the machine running the
// show, from a device that isn't it.

import React, { useEffect, useRef, useState } from 'react';
import {
  enginePort,
  mb,
  updateAvailable,
  updateCancel,
  updateCheckNow,
  updateDownload,
  updateInstall,
  updateProgress,
  updateStatus,
  type InstallProgress,
  type UpdateStatus,
} from '../update.ts';
import { openExternal } from '../shell.ts';

const STAGE_SAYS: Record<string, string> = {
  downloading: 'Downloading',
  unpacking: 'Unpacking',
  verifying: 'Checking the signature',
  ready: 'Ready to install',
  armed: 'Installing…',
  failed: 'Download failed',
};

export function UpdatePanel(): React.ReactElement | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [prog, setProg] = useState<InstallProgress | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [armed, setArmed] = useState(false);
  const disarm = useRef<number | null>(null);

  useEffect(() => {
    if (!updateAvailable()) return;
    updateStatus().then(setStatus).catch(() => setStatus(null));
    updateProgress().then(setProg).catch(() => setProg(null));
  }, []);

  // Only while something is actually moving. A panel that polls forever forks
  // codesign on the other side of the bridge.
  const running = prog?.stage === 'downloading' || prog?.stage === 'unpacking' || prog?.stage === 'verifying';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      updateProgress().then(setProg).catch(() => {});
    }, 200);
    return () => window.clearInterval(t);
  }, [running]);

  useEffect(() => () => {
    if (disarm.current) window.clearTimeout(disarm.current);
  }, []);

  if (!updateAvailable()) return null;

  const found = status?.available ?? null;
  const staged = prog?.stagedVersion ?? null;
  const blocker = prog?.blocker ?? null;
  const refusal = prog?.refusal ?? null;

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError('');
    try {
      await fn();
      setProg(await updateProgress());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProg(await updateProgress().catch(() => prog));
    } finally {
      setBusy('');
    }
  };

  const armInstall = () => {
    if (!armed) {
      setArmed(true);
      // Disarming itself matters: an armed quit button left hot for the rest of
      // the night is a trap.
      disarm.current = window.setTimeout(() => setArmed(false), 6000);
      return;
    }
    setArmed(false);
    setError('');
    updateInstall(enginePort()).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      updateProgress().then(setProg).catch(() => {});
    });
  };

  const pct = prog && prog.total > 0 ? Math.min(100, (prog.got / prog.total) * 100) : 0;

  return (
    <div className="col" style={{ gap: 10, maxWidth: 620 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
        running {status?.current ?? '…'}
        {status?.onPrerelease && (
          <span style={{ color: 'var(--text-faint)' }}> · beta channel</span>
        )}
      </div>

      {!found && (
        <div style={{ color: 'var(--text-dim)' }}>
          {status?.note ? `Last check did not get through — ${status.note}` : 'This is the newest build.'}
        </div>
      )}

      {found && (
        <>
          <div style={{ color: 'var(--good)', fontWeight: 600 }}>
            {found.version.raw} is available{found.prerelease ? ' (beta)' : ''}
            {found.size > 0 && (
              <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · {mb(found.size)}</span>
            )}
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
                  maxHeight: 200,
                  overflowY: 'auto',
                  marginTop: 6,
                }}
              >
                {found.notes}
              </div>
            </details>
          )}

          {/* A permanent inability, not a moment-in-time one. Say so once and
              point at the manual route rather than offering a dead button. */}
          {blocker ? (
            <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
              LIGHT cannot replace itself here — {blocker}.{' '}
              <button className="btn small ghost" onClick={() => openExternal(found.pageUrl || status?.releasesUrl)}>
                open the release page
              </button>
            </div>
          ) : (
            <>
              {prog && prog.stage && prog.stage !== 'ready' && prog.stage !== '' && (
                <div className="col" style={{ gap: 4 }}>
                  <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                    {STAGE_SAYS[prog.stage] ?? prog.stage}
                    {prog.stage === 'downloading' && prog.total > 0 && (
                      <span style={{ fontFamily: 'var(--mono)' }}>
                        {' '}
                        {mb(prog.got)} / {mb(prog.total)}
                      </span>
                    )}
                  </div>
                  {running && (
                    <div className="progress">
                      <div className="fill" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              )}

              {staged ? (
                <>
                  <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    {staged} is downloaded and its signature checked. Installing quits LIGHT,
                    replaces it and reopens it — the output stops while that happens, and Ableton
                    Link and MIDI reconnect after.
                  </div>
                  {refusal && (
                    <div style={{ color: 'var(--warn)', lineHeight: 1.5 }}>Not now — {refusal}</div>
                  )}
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className={`btn ${armed ? 'hot' : 'on'}`}
                      disabled={!!refusal || busy !== ''}
                      onClick={armInstall}
                      title="quits LIGHT, replaces it, and reopens it"
                    >
                      {armed ? 'Press again to quit and install' : 'Install and restart'}
                    </button>
                    <button className="btn ghost" disabled={busy !== ''} onClick={() => run('cancel', updateCancel)}>
                      Discard the download
                    </button>
                  </div>
                </>
              ) : (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn on" disabled={busy !== '' || running} onClick={() => run('download', updateDownload)}>
                    {running ? 'Working…' : `Download ${found.version.raw}`}
                  </button>
                  <button className="btn small ghost" onClick={() => openExternal(found.pageUrl || status?.releasesUrl)}>
                    or get it manually
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {error && <div style={{ color: 'var(--hot)', lineHeight: 1.5 }}>{error}</div>}

      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn small ghost"
          disabled={busy !== '' || running}
          onClick={() => run('check', async () => setStatus(await updateCheckNow()))}
        >
          {busy === 'check' ? 'Checking…' : 'Check now'}
        </button>
      </div>
    </div>
  );
}
