// What the in-app install says while it works, and after.
//
// Pure, and DOM-free on purpose: update.ts reads the page's `location`, and the
// Node suite that holds these words cannot compile anything that does.

/** What the last install did: said once, to the copy that opened after it. */
export type InstallOutcome = { ok: boolean; from: string; to: string; reason: string | null };

/** One look at a download in flight: when, and how many bytes had arrived. */
export type Reading = { at: number; got: number };

/** How fast a download is going, in bytes a second, over the last couple of
 *  seconds of readings — or null until there is enough to say. A rate over the
 *  whole download would hide a stall for as long as the download had run; one
 *  from the last two readings jumps with every chunk the network hands over. */
export function transferRate(readings: Reading[], windowMs = 2000): number | null {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1]!;
  const first = readings.find((r) => last.at - r.at <= windowMs) ?? readings[0]!;
  const dt = last.at - first.at;
  if (dt < 500) return null;
  return Math.max(0, (last.got - first.got) / (dt / 1000));
}

/** "3.1 MB/s" */
export function speedWords(bytesPerSec: number): string {
  const mbps = bytesPerSec / 1_000_000;
  return mbps >= 10 ? `${Math.round(mbps)} MB/s` : `${mbps.toFixed(1)} MB/s`;
}

/** "about 4 s left", "about 2 min left", "almost done" — or null when the rate
 *  is not known yet, which says nothing rather than a guess. */
export function timeLeftWords(remainingBytes: number, bytesPerSec: number | null): string | null {
  if (!bytesPerSec || bytesPerSec <= 0 || remainingBytes <= 0) return null;
  const s = remainingBytes / bytesPerSec;
  if (s < 1.5) return 'almost done';
  if (s < 60) return `about ${Math.ceil(s)} s left`;
  return `about ${Math.round(s / 60)} min left`;
}

/** What the copy that just opened says about the install that opened it — or
 *  nothing, when there was no install. A version compared with a leading `v`
 *  is the same version. */
export function outcomeNotice(o: InstallOutcome | null, running: string): { text: string; ok: boolean } | null {
  if (!o) return null;
  const same = (a: string, b: string) => a.replace(/^v/, '') === b.replace(/^v/, '');
  if (!o.ok) {
    return {
      ok: false,
      text: `The update to ${o.to} did not install — ${o.reason ?? 'the swap did not finish'}. LIGHT ${o.from} is still here and unchanged; the release page has ${o.to} to download.`,
    };
  }
  if (!same(o.to, running)) {
    return {
      ok: false,
      text: `LIGHT ${o.to} was put in place, but ${running} is what opened. Quit LIGHT and open it again from Applications.`,
    };
  }
  return { ok: true, text: `LIGHT updated to ${o.to} (from ${o.from}).` };
}
