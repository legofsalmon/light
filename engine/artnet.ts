import dgram from 'node:dgram';

const ARTNET_PORT = 6454;

/**
 * Art-Net ArtDmx sender. Packet layout (Art-Net 4 spec):
 * "Art-Net\0" | OpDmx 0x5000 LE | ProtVer 14 BE | Sequence | Physical |
 * SubUni | Net | Length BE | 512 data bytes.
 */
export class ArtnetOut {
  private sock: dgram.Socket;
  private seq = new Map<number, number>();
  private ready = false;
  packets = 0;

  constructor() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', (err) => {
      console.error('[artnet] socket error:', err.message);
    });
    this.sock.bind(() => {
      try {
        this.sock.setBroadcast(true);
      } catch (err) {
        console.error('[artnet] setBroadcast failed:', (err as Error).message);
      }
      this.ready = true;
    });
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

    this.sock.send(pkt, ARTNET_PORT, unicast ?? '255.255.255.255', (err) => {
      if (!err) this.packets++;
    });
  }

  close(): void {
    this.sock.close();
  }
}
