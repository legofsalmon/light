// A QR encoder, small enough to read (design 2.10).
//
// The setup surface shows a networked client the engine's address, and beside
// it the same address as a code a phone can point at — that is the whole job:
// one short http:// URL, once, on a screen. A library for that is 20 KB of
// dependency in an app that ships to a gig with no CDN, so this is the
// smallest encoder that still produces a correct code: byte mode, error
// correction level L, versions 1–5 (every one of which is a single error-
// correction block, so there is no interleaving to get wrong). Version 5 holds
// 106 bytes; `http://192.168.100.100:65535` is 28.
//
// Nothing here runs on a tick. It is called once per open of the sheet.

/** data codewords, then error-correction codewords, for level L, v1–v5 */
const CAP: [data: number, ec: number][] = [[19, 7], [34, 10], [55, 15], [80, 20], [108, 26]];
/** the 15-bit format strings for level L, mask 0–7 (BCH-encoded, from the spec) */
const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

// --- GF(256), the field Reed-Solomon works in --------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** the generator polynomial of degree `n` */
function generator(n: number): Uint8Array {
  let g = Uint8Array.of(1);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** the `n` check codewords for `data` */
function ecc(data: Uint8Array, n: number): Uint8Array {
  const g = generator(n);
  const rem = new Uint8Array(n);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[n - 1] = 0;
    for (let j = 0; j < n; j++) rem[j] ^= mul(g[j + 1], factor);
  }
  return rem;
}

// --- the module grid ---------------------------------------------------------
type Grid = { n: number; px: Int8Array; fn: Uint8Array };
const at = (g: Grid, r: number, c: number) => g.px[r * g.n + c];
const put = (g: Grid, r: number, c: number, v: number, fixed = true) => {
  g.px[r * g.n + c] = v;
  if (fixed) g.fn[r * g.n + c] = 1;
};

/** finders, separators, timing, alignment and the one module that is always
 *  dark — everything whose position the spec fixes, so the data knows to skip it */
function patterns(g: Grid, version: number): void {
  const n = g.n;
  for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = br + r;
        const x = bc + c;
        if (y < 0 || y >= n || x < 0 || x >= n) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        put(g, y, x, ring === 2 || ring > 3 ? 0 : 1);
      }
    }
  }
  for (let i = 8; i < n - 8; i++) {
    put(g, 6, i, i % 2 === 0 ? 1 : 0);
    put(g, i, 6, i % 2 === 0 ? 1 : 0);
  }
  if (version > 1) {
    const centres = [6, 4 * version + 10];
    for (const cr of centres) {
      for (const cc of centres) {
        if ((cr === 6 && cc === 6) || (cr === 6 && cc > 6) || (cc === 6 && cr > 6)) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            put(g, cr + r, cc + c, Math.max(Math.abs(r), Math.abs(c)) === 1 ? 0 : 1);
          }
        }
      }
    }
  }
  // reserve the two format strips so the zigzag steps over them
  for (let i = 0; i < 9; i++) {
    if (at(g, 8, i) < 0) put(g, 8, i, 0);
    if (at(g, i, 8) < 0) put(g, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) put(g, 8, n - 1 - i, 0);
  for (let i = 0; i < 7; i++) put(g, n - 1 - i, 8, 0);
  // the one module that is dark in every code, just above that strip
  put(g, 4 * version + 9, 8, 1);
}

/** the zigzag: two columns at a time, right to left, column 6 skipped */
function place(g: Grid, bits: Uint8Array): void {
  const n = g.n;
  let i = 0;
  let up = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const r = up ? n - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (g.fn[r * n + c]) continue;
        put(g, r, c, i < bits.length ? bits[i] : 0, false);
        i++;
      }
    }
    up = !up;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** the spec's four penalties: long runs, 2×2 blocks, finder lookalikes, and a
 *  picture that is mostly one colour. The lowest score wins the mask. */
function penalty(g: Grid): number {
  const n = g.n;
  let score = 0;
  let dark = 0;
  const line = (get: (i: number) => number) => {
    let run = 1;
    let prev = get(0);
    const hist: number[] = [];
    for (let i = 1; i < n; i++) {
      const v = get(i);
      if (v === prev) run++;
      else {
        if (run >= 5) score += run - 2;
        hist.push(run);
        run = 1;
        prev = v;
      }
    }
    if (run >= 5) score += run - 2;
    hist.push(run);
    // 1:1:3:1:1 either side of a light run of four or more = a false finder
    for (let i = 0; i + 4 < hist.length; i++) {
      const [a, b, c, d, e] = hist.slice(i, i + 5);
      if (a === b && b === d && d === e && c === 3 * a) score += 40;
    }
  };
  for (let r = 0; r < n; r++) line((i) => at(g, r, i));
  for (let c = 0; c < n; c++) line((i) => at(g, i, c));
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = at(g, r, c);
      if (v === at(g, r, c + 1) && v === at(g, r + 1, c) && v === at(g, r + 1, c + 1)) score += 3;
    }
  }
  for (let i = 0; i < n * n; i++) if (g.px[i]) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** The format string goes on twice: once around the top-left finder, once split
 *  between the other two, so a code with a torn corner still reads. */
function writeFormat(g: Grid, mask: number): void {
  const n = g.n;
  const bits = FORMAT_L[mask];
  for (let i = 0; i < 15; i++) {
    const v = (bits >> i) & 1;
    if (i < 6) put(g, 8, i, v);
    else if (i === 6) put(g, 8, 7, v);
    else if (i === 7) put(g, 8, 8, v);
    else if (i === 8) put(g, 7, 8, v);
    else put(g, 14 - i, 8, v);
    if (i < 7) put(g, n - 1 - i, 8, v);
    else put(g, 8, n - 15 + i, v);
  }
}

/** The code for `text`, as one SVG path over a grid of `size` modules — the
 *  quiet zone the spec asks for is already in `size`. `null` when the text is
 *  longer than version 5 holds, which no engine address is. */
export function qrCode(text: string): { size: number; path: string } | null {
  const bytes = new TextEncoder().encode(text);
  const version = CAP.findIndex(([d]) => bytes.length + 2 <= d) + 1;
  if (version === 0) return null;
  const [dataLen, ecLen] = CAP[version - 1];

  // mode 0100, an 8-bit length, the bytes, a terminator, then the pad pair
  const data = new Uint8Array(dataLen);
  let bit = 0;
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--, bit++) {
      if ((value >> i) & 1) data[bit >> 3] |= 0x80 >> (bit & 7);
    }
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  for (let i = (bit + 7) >> 3; i < dataLen; i++) data[i] = i % 2 === ((bit + 7) >> 3) % 2 ? 0xec : 0x11;

  const check = ecc(data, ecLen);
  const bits = new Uint8Array((dataLen + ecLen) * 8);
  [...data, ...check].forEach((b, i) => {
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >> (7 - j)) & 1;
  });

  const n = 17 + 4 * version;
  const base: Grid = { n, px: new Int8Array(n * n).fill(-1), fn: new Uint8Array(n * n) };
  patterns(base, version);
  place(base, bits);

  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const g: Grid = { n, px: Int8Array.from(base.px), fn: base.fn };
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (!g.fn[r * n + c] && MASKS[m](r, c)) g.px[r * n + c] ^= 1;
    }
    writeFormat(g, m);
    const s = penalty(g);
    if (s < bestScore) {
      bestScore = s;
      best = g;
    }
  }
  if (!best) return null;

  const quiet = 4;
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (at(best, r, c) === 1) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
  }
  return { size: n + quiet * 2, path: parts.join('') };
}
