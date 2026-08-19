// The UI's side of GDTF Share.
//
// The same bundle is served to the packaged app, to a browser on this machine,
// and to a tablet on the venue WiFi. Only the first of those has a Tauri
// runtime, because the HTTP client lives in the app shell — so everything here
// answers "is this even possible right now?" before it answers anything else,
// and the caller is expected to hide the feature rather than show it failing.

import type { ShareEntry, ShareList } from '../../shared/types.ts';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The Tauri bridge, or null in a browser. `withGlobalTauri` puts it on window,
 *  which is why this needs no npm dependency — and why a plain browser simply
 *  finds nothing here instead of failing to load a module. */
function bridge(): Invoke | null {
  const t = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return t?.core?.invoke ?? null;
}

/** Whether the Share feature can work at all in this window. */
export const shareAvailable = (): boolean => bridge() !== null;

export type ShareStatus = {
  user: string | null;
  /** fixtures in the cached catalogue; 0 = never fetched */
  cached: number;
  /** unix seconds the cache was written */
  cachedAt: number | null;
};

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = bridge();
  if (!invoke) throw new Error('GDTF Share is only available in the LIGHT app');
  return invoke<T>(cmd, args);
}

export const shareStatus = (): Promise<ShareStatus> => call<ShareStatus>('share_status');
export const shareSavedUser = (): Promise<string | null> => call<string | null>('share_saved_user');

export const shareLogin = (user: string, password: string, remember: boolean): Promise<void> =>
  call<void>('share_login', { user, password, remember });

/** Sign in from the Keychain, so "remember me" survives a restart. */
export const shareLoginSaved = (): Promise<string> => call<string>('share_login_saved');

export const shareForget = (): Promise<void> => call<void>('share_forget');

/** Pull the whole catalogue — 6.4 MB, no delta sync, so only ever on a click. */
export const shareRefresh = (): Promise<number> => call<number>('share_refresh');

/** How many fixtures the cache holds — without shipping any of them. */
export const shareCachedCount = (): Promise<number> => call<number>('share_cached_count');

/** Candidates for a query, coarsely narrowed in the shell.
 *
 *  The catalogue is 6.4 MB; pushing it through the IPC bridge so a text box can
 *  filter it is a lot of work for a keystroke, and it grows every month. The
 *  shell does the substring pass on the file it already has, and only the
 *  survivors cross — ranking still happens here, in one place, where it is
 *  tested. */
export async function shareSearch(query: string, limit = 400): Promise<ShareEntry[]> {
  const raw = await call<string>('share_search', { query, limit });
  try {
    return JSON.parse(raw) as ShareEntry[];
  } catch {
    return [];
  }
}

/** Download one fixture. Returns base64 ready for the engine's importGdtf. */
export const shareDownload = (entry: ShareEntry): Promise<string> =>
  call<string>('share_download', {
    rid: entry.rid,
    name: `${entry.manufacturer}-${entry.fixture}`,
  });
