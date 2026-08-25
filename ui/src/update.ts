// The UI's side of updates.
//
// Same shape as licence.ts and for the same reason: this bundle is served to
// the packaged app, to a browser here, and to a tablet on the venue WiFi, and
// only the first has a Tauri runtime. A tablet must never be able to press
// install — that would quit the machine running the show from a device that
// isn't it.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function bridge(): Invoke | null {
  const t = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return t?.core?.invoke ?? null;
}

/** Whether updates can be shown at all in this window. */
export const updateAvailable = (): boolean => bridge() !== null;

export type UpdateVersion = {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  raw: string;
};

export type UpdateRelease = {
  version: UpdateVersion;
  tag: string;
  notes: string;
  assetUrl: string;
  size: number;
  prerelease: boolean;
  pageUrl: string;
};

export type UpdateStatus = {
  current: string;
  available: UpdateRelease | null;
  /** why the last check found nothing — a hotspot, a rate limit */
  note: string | null;
  releasesUrl: string;
  onPrerelease: boolean;
};

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = bridge();
  if (!invoke) throw new Error('Updates are only available in the LIGHT app');
  return invoke<T>(cmd, args);
}

export const updateStatus = () => call<UpdateStatus>('update_status');
export const updateCheckNow = () => call<UpdateStatus>('update_check_now');

/** Bytes as an operator reads them. */
export function mb(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1_000_000).toFixed(0)} MB` : '';
}
