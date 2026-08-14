import dgram from 'node:dgram';

export type OscMessage = { addr: string; args: (number | string)[] };

function readPaddedString(buf: Buffer, offset: number): [string, number] {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString('ascii', offset, end);
  const next = offset + (Math.floor((end - offset) / 4) + 1) * 4;
  return [s, next];
}

/** Parse a single OSC packet (message or #bundle) into flat messages. */
export function parseOsc(buf: Buffer): OscMessage[] {
  if (buf.length < 4) return [];
  if (buf.toString('ascii', 0, 7) === '#bundle') {
    const out: OscMessage[] = [];
    let o = 16; // "#bundle\0" + 8-byte timetag
    while (o + 4 <= buf.length) {
      const size = buf.readUInt32BE(o);
      o += 4;
      if (size <= 0 || o + size > buf.length) break;
      out.push(...parseOsc(buf.subarray(o, o + size)));
      o += size;
    }
    return out;
  }
  try {
    let [addr, o] = readPaddedString(buf, 0);
    if (!addr.startsWith('/')) return [];
    let tags = '';
    if (o < buf.length && buf[o] === 0x2c) {
      [tags, o] = readPaddedString(buf, o);
      tags = tags.slice(1);
    }
    const args: (number | string)[] = [];
    for (const t of tags) {
      switch (t) {
        case 'f':
          args.push(buf.readFloatBE(o));
          o += 4;
          break;
        case 'i':
          args.push(buf.readInt32BE(o));
          o += 4;
          break;
        case 'd':
          args.push(buf.readDoubleBE(o));
          o += 8;
          break;
        case 'h':
          args.push(Number(buf.readBigInt64BE(o)));
          o += 8;
          break;
        case 's':
        case 'S': {
          const [s, next] = readPaddedString(buf, o);
          args.push(s);
          o = next;
          break;
        }
        case 'b': {
          const len = buf.readUInt32BE(o);
          o += 4 + Math.ceil(len / 4) * 4;
          break;
        }
        case 'T':
          args.push(1);
          break;
        case 'F':
          args.push(0);
          break;
        case 'N':
          break;
        default:
          return [{ addr, args }]; // unknown tag: bail with what we have
      }
    }
    return [{ addr, args }];
  } catch {
    return [];
  }
}

/** UDP OSC listener with hot rebind when the port changes. */
export class OscIn {
  private sock: dgram.Socket | null = null;
  private port: number | null = null;
  private onMessage: (msg: OscMessage) => void;
  /** null = disabled, 'on' = bound, 'failed' = the port is held elsewhere.
   *  A silent OSC link is indistinguishable from a quiet one without this. */
  private bound: 'on' | 'failed' | null = null;

  constructor(onMessage: (msg: OscMessage) => void) {
    this.onMessage = onMessage;
  }

  /** null = disabled, 'on' = bound, 'failed' = port taken by another app. */
  status(): 'on' | 'failed' | null {
    return this.bound;
  }

  listen(port: number, enabled: boolean): void {
    if (!enabled) {
      this.stop();
      this.bound = null;
      return;
    }
    if (this.sock && this.port === port) return;
    this.stop();
    this.port = port;
    // No reuseAddr: with it, a second engine binds the same OSC port and both
    // sit there splitting (or missing) Resolume's traffic while each reports a
    // healthy link. Failing loudly matches the Rust core and is what you want
    // to see at soundcheck. UDP has no TIME_WAIT, so restarts still rebind.
    const sock = dgram.createSocket({ type: 'udp4' });
    sock.on('message', (buf) => {
      for (const msg of parseOsc(buf)) this.onMessage(msg);
    });
    sock.on('error', (err) => {
      console.error(`[osc] listen error on :${port}:`, err.message);
      sock.close();
      if (this.sock === sock) {
        this.sock = null;
        this.port = null;
        this.bound = 'failed';
      }
    });
    // bind is async — only the 'listening' event proves the port was free
    sock.on('listening', () => {
      if (this.sock === sock) this.bound = 'on';
    });
    sock.bind(port);
    this.sock = sock;
  }

  stop(): void {
    this.sock?.close();
    this.sock = null;
    this.port = null;
    this.bound = null;
  }
}
