// Imported (GDTF-compiled) profiles for the Node engine, rendered through the
// SAME Rust interpreter as the Rust core — compiled to WASM so profile
// behaviour has exactly one implementation (profile-wasm/).

import { createRequire } from 'node:module';
import type { CompiledProfile } from '../shared/types.ts';
import type { ResolvedParams } from '../shared/profiles.ts';

const require = createRequire(import.meta.url);

type WasmModule = {
  parse_gdtf(bytes: Uint8Array): string;
  parse_mvr(bytes: Uint8Array): string;
  register_profile(json: string): number;
  unregister_profile(handle: number): void;
  render(handle: number, params: Float64Array): Uint8Array;
};

let wasm: WasmModule | null = null;
let wasmError = false;

function ensureWasm(): WasmModule | null {
  if (wasm || wasmError) return wasm;
  try {
    wasm = require('../profile-wasm/pkg/light_profile_wasm.js') as WasmModule;
  } catch (err) {
    wasmError = true;
    console.error(
      '[wasm] profile interpreter unavailable — build it with: cd profile-wasm && wasm-pack build --target nodejs --out-dir pkg\n',
      (err as Error).message
    );
  }
  return wasm;
}

export function parseGdtfBase64(b64: string): CompiledProfile[] {
  const w = ensureWasm();
  if (!w) throw new Error('profile interpreter (wasm) not built');
  return JSON.parse(w.parse_gdtf(Buffer.from(b64, 'base64'))) as CompiledProfile[];
}

export function parseMvrBase64(b64: string): import('../shared/types.ts').MvrBundle {
  const w = ensureWasm();
  if (!w) throw new Error('profile interpreter (wasm) not built');
  return JSON.parse(w.parse_mvr(Buffer.from(b64, 'base64')));
}

const MM: Record<string, number> = { off: 0, aim: 1, rotate: 2 };
// handle per profile id; re-registered when the profile object changes
const handles = new Map<string, { handle: number; ref: CompiledProfile }>();

export function renderImported(
  id: string,
  cp: CompiledProfile,
  heads: ResolvedParams[],
  buf: Uint8Array,
  base: number
): void {
  const w = ensureWasm();
  if (!w) return; // engine keeps ticking; fixture stays dark
  let h = handles.get(id);
  if (!h || h.ref !== cp) {
    if (h) w.unregister_profile(h.handle);
    h = { handle: w.register_profile(JSON.stringify(cp)), ref: cp };
    handles.set(id, h);
  }
  const flat = new Float64Array(heads.length * 15);
  heads.forEach((p, i) => {
    const o = i * 15;
    flat[o] = p.dimmer;
    flat[o + 1] = p.r;
    flat[o + 2] = p.g;
    flat[o + 3] = p.b;
    flat[o + 4] = p.white;
    flat[o + 5] = p.ringFx;
    flat[o + 6] = p.strobe;
    flat[o + 7] = MM[p.motorMode] ?? 0;
    flat[o + 8] = p.motorValue;
    flat[o + 9] = p.macro === null ? 0 : 1;
    flat[o + 10] = p.macro ?? 0;
    flat[o + 11] = p.pan;
    flat[o + 12] = p.tilt;
    flat[o + 13] = p.haze;
    flat[o + 14] = p.fan;
  });
  buf.set(w.render(h.handle, flat), base);
}
