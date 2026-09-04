// The UI's side of licensing.
//
// Same shape as share.ts and for the same reason: this bundle is served to the
// packaged app, to a browser on this machine, and to a tablet on the venue
// WiFi, and only the first has a Tauri runtime. A browser finds no bridge and
// the caller hides the panel rather than showing it broken.
//
// Nothing here gates anything. The only gate is in the app shell, at startup,
// before the engine exists — see src-tauri/src/main.rs.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function bridge(): Invoke | null {
  const t = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return t?.core?.invoke ?? null;
}

/** Whether licensing can be shown at all in this window. */
export const licenceAvailable = (): boolean => bridge() !== null;

export type LicenceState =
  | 'active'
  | 'update_required'
  | 'check_in_required'
  | 'expired'
  | 'wrong_machine'
  | 'invalid';

export type LicenceClaims = {
  v: number;
  key: string;
  product: string;
  edition: string;
  customer: string;
  name: string;
  seats: number;
  maintUntil: number;
  exp: number;
  machine: string;
  mode: string;
  iat: number;
  jti: string;
};

export type LicenceStatus = {
  status: LicenceState;
  machine: string;
  claims: LicenceClaims | null;
  /** false on a build made before the signing key was configured */
  configured: boolean;
  buildDate: number;
  blocksNewSession: boolean;
};

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = bridge();
  if (!invoke) throw new Error('Licensing is only available in the LIGHT app');
  return invoke<T>(cmd, args);
}

export const licenceStatus = () => call<LicenceStatus>('licence_status');
export const licenceStartTrial = (email: string, name: string) =>
  call<LicenceStatus>('licence_start_trial', { email, name });
export const licenceActivate = (key: string, label: string) =>
  call<LicenceStatus>('licence_activate', { key, label });
export const licenceHeartbeat = () => call<LicenceStatus>('licence_heartbeat');
export const licenceDeactivate = () => call<LicenceStatus>('licence_deactivate');

/** What the operator is told, per state. Deliberately plain: only one of these
 *  is the operator's problem, and only one stops a session starting. */
export function describe(s: LicenceStatus): { title: string; detail: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!s.configured) {
    return {
      title: 'Unlicensed build',
      detail:
        'This build was made before a signing key was configured, so it cannot check a licence. Everything works; nothing is restricted.',
      tone: 'warn',
    };
  }
  switch (s.status) {
    case 'active':
      return { title: 'Licensed', detail: 'Everything is in order.', tone: 'ok' };
    case 'update_required':
      return {
        title: 'Update window ended',
        detail: 'This build is newer than your maintenance covers. It keeps running — renewing gets you newer builds.',
        tone: 'warn',
      };
    case 'check_in_required':
      return {
        title: 'Needs a check-in',
        detail: 'The lease lapsed. LIGHT will retry on its own; nothing is restricted in the meantime.',
        tone: 'warn',
      };
    case 'expired':
      return {
        title: 'Trial ended',
        detail: 'Your trial has run out. A show already running is never interrupted, but LIGHT will not start a new session until this is sorted.',
        tone: 'bad',
      };
    case 'wrong_machine':
      return {
        title: 'Licensed to another machine',
        detail: 'This licence was activated elsewhere. Activate it here to move the seat.',
        tone: 'warn',
      };
    case 'invalid':
      return { title: 'No licence', detail: 'Start a trial or enter a licence key.', tone: 'warn' };
  }
}
