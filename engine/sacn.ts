import dgram from 'node:dgram';
import net from 'node:net';

import { SendHealth } from './sendHealth.ts';
import { resolve as resolveAdapter } from './netif.ts';
import { randomBytes } from 'node:crypto';

const SACN_PORT = 5568;
/** How often, at most, to rebuild a refused send socket. */
const REBIND_EVERY_MS = 2000;
const PACKET_LEN = 638; // root(38) + framing(77) + dmp(10+1+512)

/**
 * sACN (E1.31) DMX sender — root/framing/DMP layers with start code 0,
 * multicast to 239.255.hi.lo unless a unicast address is configured.
 */
export class SacnOut {
  private sock: dgram.Socket;
  private cid = randomBytes(16);
  private seq = new Map<number, number>();
  private ready = false;
  packets = 0;
  /** whether the OS is taking our packets — see sendHealth.ts */
  private health = new SendHealth();
  private lastRebind: number | null = null;
  /** the adapter the operator chose (null = automatic) — see netif.ts */
  private iface: string | null = null;
  /** the address the current socket is bound to (null = any) */
  private bound: string | null = null;
  private lastReconcile: number | null = null;

  private sourceName: string;

  constructor(sourceName = 'LIGHT look engine') {
    this.sourceName = sourceName;
    this.sock = this.openSocket(null);
  }

  /** A fresh multicast-capable send socket, ready once bound. */
  private openSocket(bind: string | null): dgram.Socket {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (err) => {
      console.error('[sacn] socket error:', err.message);
      this.health.notePermanent(`no socket: ${err.message}`);
    });
    sock.bind({ address: bind ?? '0.0.0.0', port: 0 }, () => {
      try {
        sock.setMulticastTTL(4);
      } catch {
        // fine on loopback-only setups
      }
      this.ready = true;
    });
    return sock;
  }

  /** Rebuild the send socket on whatever the chosen adapter resolves to right
   *  now — the one place a socket is replaced. */
  private rebind(why: string): void {
    const want = resolveAdapter(this.iface);
    console.error(`[sacn] send socket rebuilt (${why}) on ${want ?? 'any adapter'}`);
    this.ready = false;
    try { this.sock.close(); } catch { /* already gone */ }
    this.sock = this.openSocket(want);
    this.bound = want;
  }

  /** Choose the adapter to send from (null = automatic). Takes effect at
   *  once; a no-op when unchanged, so it is safe to call every tick. */
  setInterface(name: string | null): void {
    if (this.iface === name) return;
    this.iface = name;
    this.rebind('adapter chosen');
  }

  /** The auto pick-up: every few seconds, if the chosen adapter now resolves
   *  to a different address than the socket is bound to — it came back, its
   *  lease changed, or it went away — rebuild the socket to match. */
  reconcileInterface(): void {
    if (this.iface === null) return;
    const now = Date.now();
    if (this.lastReconcile !== null && now - this.lastReconcile < 3000) return;
    this.lastReconcile = now;
    const want = resolveAdapter(this.iface);
    if (want !== this.bound) this.rebind('adapter changed');
  }

  /** The adapter chosen and the address actually bound, for the snapshot. */
  interface(): { chosen: string | null; bound: string | null } {
    return { chosen: this.iface, bound: this.bound };
  }

  /** Rebuild the send socket when the OS is refusing our packets — the same
   *  macOS Local Network recovery as the Art-Net sender (see artnet.ts). */
  recoverIfFailing(): void {
    const now = Date.now();
    if (this.health.current(now) === null) return;
    if (this.lastRebind !== null && now - this.lastRebind < REBIND_EVERY_MS) return;
    this.lastRebind = now;
    // re-resolves the chosen adapter too, so a lease change is picked up
    // by the same rebuild; the next send's result speaks for itself
    this.rebind('refused send');
  }

  send(universe: number, data: Uint8Array, unicast: string | null): void {
    if (!this.ready || universe < 1 || universe > 63999) return;
    const seq = ((this.seq.get(universe) ?? 0) + 1) & 0xff;
    this.seq.set(universe, seq);

    const p = Buffer.alloc(PACKET_LEN);
    // --- root layer ---
    p.writeUInt16BE(0x0010, 0); // preamble size
    p.writeUInt16BE(0x0000, 2); // postamble size
    p.write('ASC-E1.17\0\0\0', 4, 'latin1');
    p.writeUInt16BE(0x7000 | (PACKET_LEN - 16), 16);
    p.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
    this.cid.copy(p, 22);
    // --- framing layer ---
    p.writeUInt16BE(0x7000 | (PACKET_LEN - 38), 38);
    p.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
    p.write(this.sourceName.slice(0, 63), 44, 'latin1');
    p[108] = 100; // priority
    p.writeUInt16BE(0, 109); // sync address
    p[111] = seq;
    p[112] = 0; // options
    p.writeUInt16BE(universe, 113);
    // --- DMP layer ---
    p.writeUInt16BE(0x7000 | (PACKET_LEN - 115), 115);
    p[117] = 0x02; // VECTOR_DMP_SET_PROPERTY
    p[118] = 0xa1; // address & data type
    p.writeUInt16BE(0, 119); // first property address
    p.writeUInt16BE(1, 121); // address increment
    p.writeUInt16BE(513, 123); // property value count (start code + 512)
    p[125] = 0; // DMX start code
    p.set(data.subarray(0, 512), 126);

    // IP literals only — a hostname (or a half-typed address) would trigger
    // DNS resolution on the 40 Hz output path. Matches artnet.ts and the
    // Rust core's parse-or-multicast fallback.
    const dest = unicast && net.isIP(unicast)
      ? unicast
      : `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
    this.sock.send(p, SACN_PORT, dest, (err) => {
      if (!err) {
        this.packets++;
      } else {
        this.health.noteErr(`${dest}: ${(err as NodeJS.ErrnoException).code ?? err.message}`, Date.now());
      }
    });
  }

  /** The OS error from a send refused within the last second, if any. */
  sendError(): string | null {
    return this.health.current(Date.now());
  }

  close(): void {
    this.sock.close();
  }
}
