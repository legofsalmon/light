import dgram from 'node:dgram';
import net from 'node:net';

import { SendHealth } from './sendHealth.ts';

const ARTNET_PORT = 6454;
/** How often, at most, to rebuild a refused send socket. */
const REBIND_EVERY_MS = 2000;

/**
 * Art-Net ArtDmx sender. Packet layout (Art-Net 4 spec):
 * "Art-Net\0" | OpDmx 0x5000 LE | ProtVer 14 BE | Sequence | Physical |
 * SubUni | Net | Length BE | 512 data bytes.
 */
type DiscoveredNode = { ip: string; name: string; lastSeen: number };

export class ArtnetOut {
  private sock: dgram.Socket;
  private seq = new Map<number, number>();
  private ready = false;
  packets = 0;
  /** whether the OS is taking our packets — see sendHealth.ts */
  private health = new SendHealth();
  private nodes = new Map<string, DiscoveredNode>();
  private pollSock: dgram.Socket | null = null;
  private pollState: 'off' | 'on' | 'failed' = 'off';
  private lastPoll = 0;
  private lastRebind: number | null = null;

  constructor() {
    this.sock = this.openSocket();
  }

  /** A fresh broadcast-capable send socket, ready once bound. */
  private openSocket(): dgram.Socket {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (err) => {
      console.error('[artnet] socket error:', err.message);
      this.health.notePermanent(`no socket: ${err.message}`);
    });
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
      } catch (err) {
        console.error('[artnet] setBroadcast failed:', (err as Error).message);
      }
      this.ready = true;
    });
    return sock;
  }

  /** Rebuild the send socket when the OS is refusing our packets. macOS pins a
   *  process's Local Network grant to the sockets it opened, so a network
   *  change — a swapped adapter, a phone tether, a VPN — silently breaks every
   *  send until the app relaunches. A fresh socket re-triggers the grant, so
   *  the rig comes back on its own in a second or two. Only while actually
   *  failing, and at most every couple of seconds. The 6454 reply listener is
   *  a separate socket and is left alone. */
  recoverIfFailing(): void {
    const now = Date.now();
    if (this.health.current(now) === null) return;
    if (this.lastRebind !== null && now - this.lastRebind < REBIND_EVERY_MS) return;
    this.lastRebind = now;
    console.error('[artnet] rebuilding the send socket to recover from a refused send');
    this.ready = false;
    try { this.sock.close(); } catch { /* already gone */ }
    this.sock = this.openSocket();
  }

  send(universe: number, data: Uint8Array, unicast: string | null): void {
    if (!this.ready) return;
    const u = universe & 0x7fff;
    let seq = (this.seq.get(u) ?? 0) + 1;
    if (seq > 255) seq = 1;
    this.seq.set(u, seq);

    const pkt = Buffer.alloc(18 + 512);
    pkt.write('Art-Net\0', 0, 'latin1');
    pkt.writeUInt16LE(0x5000, 8); // OpDmx
    pkt.writeUInt16BE(14, 10); // protocol version
    pkt[12] = seq;
    pkt[13] = 0; // physical
    pkt[14] = u & 0xff; // sub-uni
    pkt[15] = (u >> 8) & 0x7f; // net
    pkt.writeUInt16BE(512, 16);
    pkt.set(data.subarray(0, 512), 18);

    // Only IP literals — a hostname here would trigger DNS resolution on the
    // 40 Hz output path. Anything else falls back to broadcast so the rig
    // keeps receiving while the user is mid-typing an address.
    const dest = unicast && net.isIP(unicast) ? unicast : '255.255.255.255';
    // A refusal is remembered, not dropped: the kernel saying no is the one
    // thing the output dot must never hide behind "live".
    this.sock.send(pkt, ARTNET_PORT, dest, (err) => {
      if (!err) {
        this.packets++;
      } else {
        this.health.noteErr(`${dest}: ${(err as NodeJS.ErrnoException).code ?? err.message}`, Date.now());
      }
    });
  }

  /** The OS error from a send refused within the last second, if any —
   *  nothing is reaching the wire while this is set, whatever the gate says. */
  sendError(): string | null {
    return this.health.current(Date.now());
  }

  /** Send an ArtPoll every ~3 s while any universe outputs Art-Net, and
   *  lazily open the reply listener. Discovery answers the first question at
   *  every gig — "is the node even receiving?" — so its health is surfaced,
   *  never assumed. */
  pollTick(enabled: boolean, unicasts: (string | null)[] = []): void {
    // LIGHT_NO_ARTPOLL: test harnesses must never bind 6454 or broadcast
    // polls onto a real LAN (an MVR import can re-enable artnet mid-run)
    if (!enabled || process.env.LIGHT_NO_ARTPOLL) return;
    if (this.pollState === 'off') this.openPollListener();
    if (this.pollState !== 'on') return; // failed: stay quiet, don't spam
    const now = Date.now();
    if (!this.ready || now - this.lastPoll < 3000) return;
    this.lastPoll = now;
    // prune here too — the node map must not grow without a UI attached
    for (const [ip, n] of this.nodes) {
      if (now - n.lastSeen > 30000) this.nodes.delete(ip);
    }
    const pkt = Buffer.alloc(14);
    pkt.write('Art-Net\0', 0, 'latin1');
    pkt.writeUInt16LE(0x2000, 8); // OpPoll
    pkt.writeUInt16BE(14, 10); // protocol version
    pkt[12] = 0; // TalkToMe: unicast replies, no diagnostics
    pkt[13] = 0; // priority
    this.sock.send(pkt, ARTNET_PORT, '255.255.255.255');
    // routed/unicast rigs never hear a local broadcast — poll them directly
    const seen = new Set<string>();
    for (const ip of unicasts) {
      if (!ip || seen.has(ip) || !net.isIP(ip)) continue;
      seen.add(ip);
      this.sock.send(pkt, ARTNET_PORT, ip);
    }
  }

  pollStatus(): 'on' | 'failed' | 'off' {
    return this.pollState;
  }

  private openPollListener(): void {
    const ps = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    ps.on('error', (err) => {
      // 6454 held by other lighting software — degrade to "unknown", the
      // status dot explains, and we never retry-loop
      console.error('[artnet] poll listener unavailable:', err.message);
      this.pollState = 'failed';
      try { ps.close(); } catch { /* already closed */ }
      this.pollSock = null;
    });
    ps.on('message', (msg, rinfo) => {
      if (msg.length < 44 || msg.toString('latin1', 0, 8) !== 'Art-Net\0') return;
      if (msg.readUInt16LE(8) !== 0x2100) return; // OpPollReply only
      const rawName = msg.toString('latin1', 26, 44);
      const name = rawName.split('\0')[0].trim() || rinfo.address;
      this.nodes.set(rinfo.address, { ip: rinfo.address, name, lastSeen: Date.now() });
    });
    ps.bind(ARTNET_PORT, () => {
      this.pollState = 'on';
    });
    this.pollSock = ps;
  }

  /** Fresh node list for the snapshot; entries silent > 30 s are dropped. */
  nodesSnapshot(): { ip: string; name: string; ageMs: number }[] {
    const now = Date.now();
    const out: { ip: string; name: string; ageMs: number }[] = [];
    for (const n of this.nodes.values()) {
      if (now - n.lastSeen > 30000) {
        this.nodes.delete(n.ip);
        continue;
      }
      out.push({ ip: n.ip, name: n.name, ageMs: now - n.lastSeen });
    }
    return out.sort((a, b) => a.ip.localeCompare(b.ip)).slice(0, 8);
  }

  close(): void {
    this.sock.close();
    this.pollSock?.close();
  }
}
