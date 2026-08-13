import type { HeadRef, HeadSnap, LayerSnap, MotorMode } from '../shared/types.ts';
import { clamp, lerp } from '../shared/types.ts';
import type { HeadKind, ResolvedParams } from '../shared/profiles.ts';
import { PROFILES, defaultResolved } from '../shared/profiles.ts';
import { renderImported } from './wasmProfiles.ts';
import { applyEffects } from '../shared/effects.ts';
import { DERBY_MACROS, derbyMacroForValue, derbyQuantize, hsvToRgb, rgbToHsv } from '../shared/color.ts';
import type { EngineState } from './state.ts';

type NumField = 'dimmer' | 'white' | 'ringFx' | 'strobe' | 'pan' | 'tilt' | 'haze' | 'fan' | 'motorValue';
const NUM_FIELDS: NumField[] = ['dimmer', 'white', 'ringFx', 'strobe', 'pan', 'tilt', 'haze', 'fan', 'motorValue'];

type Acc = {
  num: Partial<Record<NumField, { v: number; w: number }>>;
  col: { r: number; g: number; b: number; w: number } | null;
  motorMode: MotorMode | null;
  macro: number | undefined;
};

export type TickResult = {
  buffers: Map<string, Uint8Array>;
  heads: HeadSnap[];
  layers: LayerSnap[];
  beat: number;
};

export class Renderer {
  /** Effect-time in beats, integrated so speed-master changes never jump phase. */
  private effBeat = 0;
  private lastT: number | null = null;
  private st: EngineState;

  constructor(st: EngineState) {
    this.st = st;
  }

  /** Land the effect phase on a downbeat (tap / resync). */
  alignPhase(): void {
    this.effBeat = Math.round(this.effBeat);
  }

  tick(t: number): TickResult {
    const st = this.st;
    const p = st.project;
    const beat = st.clock.beatAt(t);
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    this.effBeat += (dt / 60000) * st.clock.bpm * st.speed;
    if (!Number.isFinite(this.effBeat)) this.effBeat = 0; // never let NaN become absorbing

    // --- resolved params per head, starting from profile defaults ---
    const heads = new Map<string, ResolvedParams>();
    const headOrder: { key: string; fixtureId: string; head: number; kind: HeadKind }[] = [];
    for (const f of p.fixtures) {
      const profHeads = PROFILES[f.profileId]?.heads ?? p.profiles?.[f.profileId]?.heads;
      if (!profHeads) continue;
      profHeads.forEach((hd, i) => {
        const key = `${f.id}:${i}`;
        heads.set(key, defaultResolved());
        headOrder.push({ key, fixtureId: f.id, head: i, kind: hd.kind });
      });
    }
    const groupHeads = new Map<string, HeadRef[]>(p.groups.map((g) => [g.id, g.heads]));

    // --- layer stack (index 0 = bottom) ---
    const layerSnaps: LayerSnap[] = [];
    for (const layer of p.layers) {
      const live = st.layerLive(layer.id);
      const tau = live.fadeDur <= 0 ? 1 : clamp((t - live.fadeStart) / (live.fadeDur * 1000));
      if (tau >= 1 && live.prevId) live.prevId = null;
      layerSnaps.push({ id: layer.id, lookId: live.lookId, prevId: live.prevId, col: live.col, t: tau });
      if (!live.lookId && !live.prevId) continue;

      // Weighted combination of the outgoing and incoming look, per head.
      const acc = new Map<string, Acc>();
      const sources = [
        { lookId: live.prevId, w: 1 - tau, incoming: false },
        { lookId: live.lookId, w: tau, incoming: true },
      ];
      for (const src of sources) {
        if (!src.lookId || src.w <= 0.001) continue;
        const look = p.looks[src.lookId];
        if (!look) continue;
        for (const part of look.parts) {
          const refs = groupHeads.get(part.groupId) ?? [];
          const n = refs.length;
          for (let j = 0; j < n; j++) {
            const ref = refs[j];
            const key = `${ref.fixtureId}:${ref.head}`;
            if (!heads.has(key)) continue;
            const prm = applyEffects(part.params, part.effects, this.effBeat, j, n);
            let a = acc.get(key);
            if (!a) {
              a = { num: {}, col: null, motorMode: null, macro: undefined };
              acc.set(key, a);
            }
            const addNum = (field: NumField, v: number | undefined) => {
              if (v === undefined) return;
              const c = a.num[field] ?? (a.num[field] = { v: 0, w: 0 });
              c.v += v * src.w;
              c.w += src.w;
            };
            addNum('dimmer', prm.dimmer);
            addNum('white', prm.white);
            addNum('ringFx', prm.ringFx);
            addNum('strobe', prm.strobe);
            addNum('pan', prm.pan);
            addNum('tilt', prm.tilt);
            addNum('haze', prm.haze);
            addNum('fan', prm.fan);
            addNum('motorValue', prm.motorValue);
            if (prm.color) {
              const [r, g, b] = hsvToRgb(prm.color.h, prm.color.s, 1);
              const c = a.col ?? (a.col = { r: 0, g: 0, b: 0, w: 0 });
              c.r += r * src.w;
              c.g += g * src.w;
              c.b += b * src.w;
              c.w += src.w;
            }
            // Banded/snap fields take the incoming look's value from fade start.
            if (prm.motorMode !== undefined && (src.incoming || a.motorMode === null)) a.motorMode = prm.motorMode;
            if (prm.macro !== undefined && (src.incoming || a.macro === undefined)) a.macro = prm.macro;
          }
        }
      }

      // Apply the layer onto the stack.
      const m = layer.master;
      for (const [key, a] of acc) {
        const out = heads.get(key)!;
        for (const f of NUM_FIELDS) {
          const c = a.num[f];
          if (!c || c.w <= 0) continue;
          const val = c.v / c.w;
          const sw = Math.min(1, c.w);
          const isIntensity = f === 'dimmer' || f === 'white';
          if (layer.blend === 'multiply' && isIntensity) {
            const factor = lerp(1, lerp(1, val, sw), m);
            out[f] = clamp(out[f] * factor);
          } else if (layer.blend === 'htp' && isIntensity) {
            out[f] = Math.max(out[f], clamp(val * m) * sw);
          } else {
            out[f] = clamp(lerp(out[f], isIntensity ? val * m : val, sw));
          }
        }
        if (a.col && a.col.w > 0) {
          const sw = Math.min(1, a.col.w);
          out.r = clamp(lerp(out.r, a.col.r / a.col.w, sw));
          out.g = clamp(lerp(out.g, a.col.g / a.col.w, sw));
          out.b = clamp(lerp(out.b, a.col.b / a.col.w, sw));
        }
        if (a.motorMode !== null) out.motorMode = a.motorMode;
        if (a.macro !== undefined) out.macro = a.macro;
      }
    }

    // --- manual haze is merged HTP so looks can only add ---
    for (const ho of headOrder) {
      if (ho.kind !== 'hazer') continue;
      const o = heads.get(ho.key)!;
      o.haze = Math.max(o.haze, p.settings.haze);
      o.fan = Math.max(o.fan, p.settings.hazeFan);
    }

    // --- grand master & blackout ---
    for (const [, o] of heads) {
      o.dimmer = clamp(o.dimmer * st.master);
      o.white = clamp(o.white * st.master);
      if (st.blackout) {
        o.dimmer = 0;
        o.white = 0;
        o.strobe = 0;
        o.ringFx = 0;
      }
    }

    // --- render to DMX buffers ---
    const buffers = new Map<string, Uint8Array>();
    for (const u of p.universes) buffers.set(u.id, new Uint8Array(512));
    for (const f of p.fixtures) {
      const buf = buffers.get(f.universeId);
      if (!buf) continue;
      const base = f.address - 1;
      const prof = PROFILES[f.profileId];
      if (prof) {
        if (base < 0 || base + prof.channels > 512) continue;
        const hp = prof.heads.map((_, i) => heads.get(`${f.id}:${i}`)!);
        prof.render(hp, buf, base);
        continue;
      }
      const cp = p.profiles?.[f.profileId];
      if (!cp) continue;
      if (base < 0 || base + cp.footprint > 512) continue;
      const hp = cp.heads.map((_, i) => heads.get(`${f.id}:${i}`)!);
      renderImported(f.profileId, cp, hp, buf, base);
    }

    // --- previz snapshot ---
    const headSnaps: HeadSnap[] = headOrder.map((ho) => {
      const o = heads.get(ho.key)!;
      let r = o.r, g = o.g, b = o.b, i = o.dimmer;
      let mc: [number, number, number][] | undefined;
      if (ho.kind === 'derby') {
        const lit = o.dimmer > 0.02;
        const macro = !lit
          ? DERBY_MACROS[0]
          : o.macro !== null
            ? derbyMacroForValue(o.macro)
            : (() => {
              const [h, s] = rgbToHsv(o.r, o.g, o.b);
              return derbyQuantize(h, s);
            })();
        mc = macro.comps;
        if (macro.comps.length === 0) i = 0;
        else {
          let ar = 0, ag = 0, ab = 0;
          for (const [cr, cg, cb] of macro.comps) {
            ar += cr; ag += cg; ab += cb;
          }
          const n = macro.comps.length * 255;
          r = ar / n; g = ag / n; b = ab / n;
        }
      }
      if (ho.kind === 'hazer') {
        i = o.haze;
        r = g = b = 0.85;
      }
      const ring = o.white >= 0.5 ? 1 : o.ringFx > 0.01 ? 0.5 : 0;
      const snap: HeadSnap = {
        f: ho.fixtureId, h: ho.head,
        r, g, b, i,
        st: o.strobe, ring, mm: o.motorMode, mv: o.motorValue,
        pan: o.pan, tilt: o.tilt,
      };
      if (mc && mc.length) snap.mc = mc;
      return snap;
    });

    return { buffers, heads: headSnaps, layers: layerSnaps, beat };
  }
}
