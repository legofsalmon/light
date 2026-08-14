import dgram from 'node:dgram';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const SACN_PORT = 5568;
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

  private sourceName: string;

  constructor(sourceName = 'LIGHT look engine') {
    this.sourceName = sourceName;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', (err) => {
      console.error('[sacn] socket error:', err.message);
    });
    this.sock.bind(() => {
      try {
        this.sock.setMulticastTTL(4);
      } catch {
        // fine on loopback-only setups
      }
      this.ready = true;
    });
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
      if (!err) this.packets++;
    });
  }

  close(): void {
    this.sock.close();
  }
}
