// Boot a real engine on a scratch project directory and read what its first
// client is greeted with. The smoke suite boots the Node engine this way and the
// parity harness boots both, so the two engines are asked the same question
// through the same harness.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

export type Notice = { ok: boolean; message: string };

/** A write cut short. */
export const TORN = '{ "version": 1, "name": "Friday", "fixtures": [';

/** A show that opens. */
const READABLE = fs.readFileSync(path.join(process.cwd(), 'core', 'tests', 'data', 'demo_project.json'), 'utf8');

/** What is on disk at boot; whether the engine should warn that a saved show
 *  could not be read; and which show `.current` names afterwards (absent: no
 *  pointer was written). Only a show that was there and would not parse warns —
 *  a first run has no file to warn about — and only a dead pointer falls back to
 *  the default: a corrupt show is the show that failed, and the demo starts
 *  under its name. The Rust twin of these is
 *  a_first_run_is_not_a_show_that_could_not_be_read in core/tests/smoke.rs. */
export const BOOT_CASES: { name: string; files: Record<string, string>; warns: boolean; current?: string }[] = [
  { name: 'an empty directory (a first run)', files: {}, warns: false },
  { name: 'a corrupt show with no backups', files: { 'default.project.json': TORN }, warns: true },
  { name: 'a missing show whose backups will not parse', files: { 'default.project.json.bak1': TORN }, warns: true },
  { name: 'a pointer to a show with nothing saved anywhere', files: { '.current': 'friday' }, warns: false, current: 'default' },
  { name: 'a pointer to a show that left only unreadable backups', files: { '.current': 'friday', 'friday.project.json.bak1': TORN }, warns: true, current: 'default' },
  {
    name: 'a corrupt named show beside a readable default',
    files: { '.current': 'friday', 'friday.project.json': TORN, 'default.project.json': READABLE },
    warns: true,
    current: 'friday',
  },
];

/** The show `.current` names in `dir`, or undefined when there is no pointer. */
export function pointer(dir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, '.current'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** The notices a first client is greeted with, or null while nothing is
 *  listening yet. The greeting is project, history, any boot notice, then
 *  midiInputs, in that order on one socket in both engines, so reading up to
 *  midiInputs has seen every notice there is without a sleep. Listening starts
 *  before the socket opens, not after: frames that arrive in the handshake's own
 *  read are replayed ahead of any promise continuation, and would be missed. */
function greeting(port: number, ms: number): Promise<Notice[] | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const notices: Notice[] = [];
    let open = false;
    const timer = setTimeout(() => {
      reject(new Error(`no greeting within ${ms} ms`));
      ws.terminate();
    }, ms);
    ws.on('open', () => (open = true));
    ws.on('error', () => {}); // 'close' always follows, and decides
    ws.on('close', () => {
      clearTimeout(timer);
      if (open) reject(new Error('the socket closed before the greeting ended'));
      else resolve(null);
    });
    ws.on('message', (data) => {
      const ev = JSON.parse(String(data));
      if (ev.type === 'toast') notices.push({ ok: ev.ok, message: ev.message });
      if (ev.type === 'midiInputs') {
        clearTimeout(timer);
        resolve(notices);
        ws.close();
      }
    });
  });
}

/** Boot one engine on `dir` — always the caller's scratch directory, on a spare
 *  port, with ArtPoll and MIDI off; outputs are off at every boot — and return
 *  the notices in its greeting. The Rust engine is the debug build that
 *  `npm run test:parity` makes. */
export async function bootNotices(engine: 'node' | 'rust', dir: string): Promise<Notice[]> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const [command, args]: [string, string[]] =
    engine === 'node'
      ? [process.execPath, ['engine/index.ts']]
      : [path.join(process.cwd(), 'target', 'debug', 'light-engine'), []];
  const child = spawn(command, args, {
    env: {
      ...process.env,
      LIGHT_PORT: String(port),
      LIGHT_PROJECT_DIR: dir,
      LIGHT_NO_ARTPOLL: '1',
      LIGHT_NO_MIDI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let failed = false; // it never started — a missing binary, say
  child.on('error', (err) => {
    failed = true;
    log += String(err);
  });
  const gone = () => failed || child.exitCode !== null || child.signalCode !== null;
  const kill = () => child.kill('SIGKILL');
  process.once('exit', kill); // an engine must never outlive the suite
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (gone()) throw new Error(`${engine} engine exited during boot: ${log}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${engine} engine on :${port} after 15 s: ${log}`);
      const notices = await greeting(port, left).catch((err: Error) => {
        throw new Error(`${engine}: ${err.message}: ${log}`);
      });
      if (notices) return notices;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    process.removeListener('exit', kill);
    if (!gone()) {
      const exited = new Promise((r) => child.once('exit', r));
      kill();
      await exited;
    }
  }
}
