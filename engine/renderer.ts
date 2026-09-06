import type { HeadRef, HeadSnap, LayerSnap, LookPart, MotorMode, StrobeMode } from '../shared/types.ts';
import { clamp, lerp } from '../shared/types.ts';
import type { HeadKind, ResolvedParams } from '../shared/profiles.ts';
import { PROFILES, defaultResolved } from '../shared/profiles.ts';
import { renderImported } from './wasmProfiles.ts';
import { applyEffects, modWave, softBase } from '../shared/effects.ts';
import { NO_EXTENTS, NO_GEOM, buildGeometry, buildGroupExtents, type GroupExtents, type HeadGeom } from '../shared/geometry.ts';
import { DERBY_MACROS, derbyMacroForValue, derbyQuantize, hsvToRgb, rgbToHsv } from '../shared/color.ts';
import type { EngineState } from './state.ts';
import { applySoftEffect, applySoftParam } from './state.ts';
import type { Effect, ModBinding, PartParams, SoftField } from '../shared/types.ts';
import { softClamp } from '../shared/types.ts';

// Fixtures whose render already threw once. A bad fixture must not be able to
// spam the log at 40 Hz, and it must not be able to take the tick down either.
const brokenFixtures = new Set<string>();

type NumField = 'dimmer' | 'white' | 'ringFx' | 'strobe' | 'pan' | 'tilt' | 'haze' | 'fan' | 'motorValue';
const NUM_FIELDS: NumField[] = ['dimmer', 'white', 'ringFx', 'strobe', 'pan', 'tilt', 'haze', 'fan', 'motorValue'];

// Beam parameters ride a parallel track to the fields above because they are
// OPTIONAL: a look that never mentions zoom must leave zoom alone, so there is
// no neutral value to merge from. Keeping them separate also leaves the
// existing merge untouched, so a saved show still renders byte for byte.
// Mirrors BeamField/ALL_BEAM in core/src/renderer.rs — order is not load
// bearing here, but keeping the two lists identical is how they stay in step.
type BeamField = 'zoom' | 'focus' | 'iris' | 'frost' | 'cto' | 'goboRotate' | 'prismRotate';
const BEAM_FIELDS: BeamField[] = ['zoom', 'focus', 'iris', 'frost', 'cto', 'goboRotate', 'prismRotate'];

type Acc = {
  num: Partial<Record<NumField, { v: number; w: number }>>;
  beam: Partial<Record<BeamField, { v: number; w: number }>>;
  col: { r: number; g: number; b: number; w: number } | null;
  motorMode: MotorMode | null;
  macro: number | undefined;
  // banded like macro: the wheel slots and the shutter pattern snap, they
  // never blend — half a gobo is not a thing
  gobo: number | undefined;
  prism: number | undefined;
  strobeMode: StrobeMode | null;
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
  /** TEST ONLY — when true the effect clock is frozen so a moving effect is
   *  byte-comparable between the two engines. Set via the LIGHT_TEST_CLOCK-gated
   *  _pinClock command; never true in a show. */
  private pinned = false;
  private lastT: number | null = null;
  private st: EngineState;
  /** Cue-list anchors, keyed "layerId lookId" (space-joined; neither id can
   *  contain spaces): the trigger this anchor belongs to (fadeStart) and the
   *  effBeat it started at. Keyed per layer+look so a cue-to-cue crossfade
   *  keeps the outgoing cue's phase, and anchoring at trigger time keeps the
   *  two engines in the same step. */
  private cueAnchors = new Map<string, { fadeStart: number; at: number }>();
  /** Phase corrections, keyed "layerId lookId partId effectId": absorbs the
   *  discontinuity when an effect's rate is edited while its look is live, so
   *  `beat/rate + corr` stays continuous. lastRate is the rate we last folded
   *  in. For an untouched effect corr stays exactly 0. GC'd with cueAnchors. */
  private rateCorr = new Map<string, { lastRate: number; corr: number }>();
  /** Per-head world geometry, keyed like the heads map ("fixtureId:head").
   *  Gen-gated: rebuilt only when the project generation moves — the first
   *  gen-keyed cache in either renderer, so the discipline is set here: compare
   *  by INEQUALITY (gen wraps), rebuild whole, never patch. */
  private geom: Map<string, HeadGeom> = new Map();
  /** Per-group spatial extents for the fan bases — same gen gate as geom. */
  private extents: Map<string, GroupExtents> = new Map();
  /** Modulator bindings indexed by JSON [lookId, partId] (P2) — same gen gate.
   *  Each entry carries the modulator's array index so its per-tick value can
   *  be looked up, and the S&H random seed stays stable. */
  private modIndex: Map<string, (ModBinding & { modIdx: number })[]> = new Map();
  private geomGen = -1; // st.gen starts at 1 and wraps at 32 bits; never -1

  constructor(st: EngineState) {
    this.st = st;
  }

  /** TEST ONLY: pin the effect clock to a fixed beat and freeze integration. */
  pinClock(effBeat: number): void {
    this.effBeat = effBeat;
    this.pinned = true;
  }

  /** Per-effect phase corrections for one part, aligned with `part.effects`.
   *  When an effect's rate has changed since we last saw it, fold the jump
   *  into corr so `beat/rate + corr` is continuous across the edit. An effect
   *  whose rate never changes yields 0 every tick, so an untouched show renders
   *  byte-for-byte as before. A non-positive rate carries no continuity (the
   *  effect is inactive), so we only re-anchor lastRate without touching corr. */
  private effectCorr(layerId: string, lookId: string, partId: string, effects: Effect[]): number[] {
    const beat = this.effBeat;
    return effects.map((e) => {
      const key = `${layerId} ${lookId} ${partId} ${e.id}`;
      let entry = this.rateCorr.get(key);
      if (!entry) {
        entry = { lastRate: e.rate, corr: 0 };
        this.rateCorr.set(key, entry);
      }
      if (entry.lastRate !== e.rate) {
        if (entry.lastRate > 0 && e.rate > 0) {
          entry.corr += beat * (1 / entry.lastRate - 1 / e.rate);
        }
        entry.lastRate = e.rate;
      }
      return entry.corr;
    });
  }

  /** Land the effect phase on a downbeat (tap / resync). */
  alignPhase(): void {
    const rounded = Math.round(this.effBeat);
    // shift cue anchors by the same delta so running cue lists keep their
    // step position - and the two engines (whose absolute effBeats differ)
    // stay in the same step through a tap
    const delta = rounded - this.effBeat;
    for (const a of this.cueAnchors.values()) a.at += delta;
    this.effBeat = rounded;
  }

  /** Follow a cue-list look to its active step (one level; a step that
   *  points at another cue list renders dark). Non-cue looks pass through.
   *  Steps are normalised here, not in sanitize, so both engines apply the
   *  exact same rules to whatever reaches them. */
  private resolveCue(lookId: string, layerId: string, fadeStart: number) {
    const p = this.st.project;
    // Object.hasOwn: a step id like "constructor" must resolve to nothing,
    // not to Object.prototype - an inherited value here crashed the tick
    const look = Object.hasOwn(p.looks, lookId) ? p.looks[lookId] : undefined;
    if (!look) return undefined;
    const steps = look.steps;
    if (!steps || steps.length === 0) return look;
    const beatsOf = (b: number) => (Number.isFinite(b) && b > 0 ? Math.min(b, 512) : 1);
    const total = steps.reduce((sum, st) => sum + beatsOf(st.beats), 0);
    // one anchor per (layer, look): a new trigger (fadeStart) restarts it,
    // and the outgoing look of a crossfade (fadeStart -1) keeps its own
    const key = `${layerId} ${lookId}`;
    let anchor = this.cueAnchors.get(key);
    if (fadeStart >= 0 && (!anchor || anchor.fadeStart !== fadeStart)) {
      anchor = { fadeStart, at: this.effBeat };
      this.cueAnchors.set(key, anchor);
    }
    const at = anchor ? anchor.at : this.effBeat;
    let pos = (this.effBeat - at) % total;
    if (!Number.isFinite(pos)) pos = 0;
    if (pos < 0) pos += total;
    for (const st of steps) {
      const b = beatsOf(st.beats);
      if (pos < b) {
        const target = Object.hasOwn(p.looks, st.lookId) ? p.looks[st.lookId] : undefined;
        if (!target || (target.steps && target.steps.length > 0)) return undefined;
        return target;
      }
      pos -= b;
    }
    return undefined;
  }

  /** Drop anchors whose (layer, look) is no longer live or fading - keeps
   *  the map from growing forever as looks and layers come and go. */
  private pruneCueAnchors(): void {
    if (this.cueAnchors.size === 0 && this.rateCorr.size === 0) return;
    const alive = new Set<string>();
    for (const layer of this.st.project.layers) {
      const live = this.st.layerLive(layer.id);
      if (live.lookId) alive.add(`${layer.id} ${live.lookId}`);
      if (live.prevId) alive.add(`${layer.id} ${live.prevId}`);
    }
    for (const key of this.cueAnchors.keys()) {
      if (!alive.has(key)) this.cueAnchors.delete(key);
    }
    // rateCorr keys are "layer look part effect" - the first two tokens are the
    // same (layer, look) scope, so the same alive set gates both maps.
    for (const key of this.rateCorr.keys()) {
      const sp = key.indexOf(' ', key.indexOf(' ') + 1);
      if (!alive.has(key.slice(0, sp))) this.rateCorr.delete(key);
    }
  }

  tick(t: number): TickResult {
    const st = this.st;
    const p = st.project;
    const beat = st.clock.beatAt(t);
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    if (!this.pinned) this.effBeat += (dt / 60000) * st.clock.bpm * st.speed;
    if (!Number.isFinite(this.effBeat)) this.effBeat = 0; // never let NaN become absorbing

    // world geometry rebuilds only when the project changed — never per tick.
    // Soft rides sweep here too: same discipline, and a ride whose look was
    // deleted out from under it must not linger as a dangling address.
    if (this.geomGen !== st.gen) {
      this.geom = buildGeometry(p);
      this.extents = buildGroupExtents(p, this.geom);
      st.sweepSoft();
      this.modIndex = new Map();
      (p.modulators ?? []).forEach((m, modIdx) => {
        if (!m.on) return;
        for (const b of m.bindings) {
          const key = JSON.stringify([b.lookId, b.partId]);
          let list = this.modIndex.get(key);
          if (!list) {
            list = [];
            this.modIndex.set(key, list);
          }
          list.push({ ...b, modIdx });
        }
      });
      this.geomGen = st.gen;
    }

    // Modulator values for THIS tick: pure functions of the shared beat, one
    // evaluation per modulator however many bindings it fans to.
    let modValues: number[] | null = null;
    if (this.modIndex.size > 0) {
      modValues = (p.modulators ?? []).map((m, i) =>
        m.on && m.rate > 0 ? modWave(m.wave, this.effBeat / m.rate + m.phase, i) : 0.5,
      );
    }

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
        const look = this.resolveCue(src.lookId, layer.id, src.incoming ? live.fadeStart : -1);
        if (!look) continue;
        for (const part of look.parts) {
          // skip a dangling-group part BEFORE touching effectCorr, exactly as
          // the Rust renderer does — running the corr bookkeeping for a part
          // Rust never reaches would accumulate rate corrections here only,
          // and the two engines would render different phases if the group
          // ever reappeared under the same id mid-look
          const refs = groupHeads.get(part.groupId);
          if (!refs) continue;
          const n = refs.length;
          // P1: resolve the soft layer into an effective view BEFORE the
          // seam — stored → soft, one lookup per part, copies only when a
          // ride actually targets this part. The rate-corr map reads the
          // EFFECTIVE effects, so a soft rate ride stays phase-continuous.
          // keyed by the RESOLVED look (a cue list renders its step's look,
          // and the ride addresses the look being edited — the step)
          const patch = st.soft.size > 0 ? st.soft.get(JSON.stringify([look.id, part.id])) : undefined;
          let effParams = part.params;
          if (patch && patch.params.size > 0) {
            effParams = { ...part.params, color: part.params.color ? { ...part.params.color } : undefined };
            for (const [field, v] of patch.params) applySoftParam(effParams, field, v);
          }
          let effEffects = part.effects;
          if (patch && patch.effects.size > 0) {
            effEffects = part.effects.map((e) => {
              const fields = patch.effects.get(e.id);
              if (!fields) return e;
              const c = { ...e };
              for (const [field, v] of fields) applySoftEffect(c, field, v);
              return c;
            });
          }
          // P2: modulator offsets ride ON TOP of stored → soft, clamped
          // per-field. Copies are forced only for parts actually bound.
          const modBinds = modValues ? this.modIndex.get(JSON.stringify([look.id, part.id])) : undefined;
          if (modBinds && modValues) {
            // copy EVERY entry unconditionally: after a soft-effect patch,
            // effEffects is a new ARRAY whose un-ridden entries are still the
            // STORED Effect objects — an identity guard on the array missed
            // that and applySoftEffect corrupted the show in place
            effParams = { ...effParams, color: effParams.color ? { ...effParams.color } : undefined };
            effEffects = effEffects.map((e) => ({ ...e }));
            for (const b of modBinds) {
              const w = modValues[b.modIdx];
              const offset = (w - 0.5) * b.depth * (b.field === 'hue' ? 360 : 1);
              if (b.effectId !== undefined) {
                const e = effEffects.find((x) => x.id === b.effectId);
                if (!e) continue;
                const v = softClamp(b.field, (e as unknown as Record<string, number>)[b.field] + offset);
                if (v !== null) applySoftEffect(e, b.field, v);
              } else {
                const v = softClamp(b.field, softBase(effParams, b.field) + offset);
                if (v !== null) applySoftParam(effParams, b.field, v);
              }
            }
          }
          // one lookup per part per tick, shared by every head
          const corr = this.effectCorr(layer.id, src.lookId, part.id, effEffects);
          const ext = this.extents.get(part.groupId) ?? NO_EXTENTS;
          for (let j = 0; j < n; j++) {
            const ref = refs[j];
            const key = `${ref.fixtureId}:${ref.head}`;
            if (!heads.has(key)) continue;
            // present in `heads` ⇒ present in geom (same enumeration built
            // both); NO_GEOM is defence in depth, not an expected path
            const g = this.geom.get(key) ?? NO_GEOM;
            const prm = applyEffects(effParams, effEffects, this.effBeat, corr, j, n, g, ext);
            let a = acc.get(key);
            if (!a) {
              a = { num: {}, beam: {}, col: null, motorMode: null, macro: undefined, gobo: undefined, prism: undefined, strobeMode: null };
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
            const acr = a;
            const addBeam = (field: BeamField, v: number | undefined) => {
              if (v === undefined) return;
              const c = acr.beam[field] ?? (acr.beam[field] = { v: 0, w: 0 });
              c.v += v * src.w;
              c.w += src.w;
            };
            for (const f of BEAM_FIELDS) addBeam(f, prm[f]);
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
            if (prm.gobo !== undefined && (src.incoming || a.gobo === undefined)) a.gobo = prm.gobo;
            if (prm.prism !== undefined && (src.incoming || a.prism === undefined)) a.prism = prm.prism;
            if (prm.strobeMode !== undefined && (src.incoming || a.strobeMode === null)) a.strobeMode = prm.strobeMode;
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
        for (const f of BEAM_FIELDS) {
          const c = a.beam[f];
          if (!c || c.w <= 0) continue;
          const val = clamp(c.v / c.w);
          const sw = Math.min(1, c.w);
          // A beam parameter is never an intensity, so layer master and blend
          // mode do not scale it — half master must not mean half zoom. The
          // first layer to speak sets it; later ones crossfade from there.
          const cur = out[f];
          out[f] = cur === null ? val : clamp(lerp(cur, val, sw));
        }
        if (a.col && a.col.w > 0) {
          const sw = Math.min(1, a.col.w);
          out.r = clamp(lerp(out.r, a.col.r / a.col.w, sw));
          out.g = clamp(lerp(out.g, a.col.g / a.col.w, sw));
          out.b = clamp(lerp(out.b, a.col.b / a.col.w, sw));
        }
        if (a.motorMode !== null) out.motorMode = a.motorMode;
        if (a.macro !== undefined) out.macro = a.macro;
        if (a.gobo !== undefined) out.gobo = a.gobo;
        if (a.prism !== undefined) out.prism = a.prism;
        if (a.strobeMode !== null) out.strobeMode = a.strobeMode;
      }
    }

    this.pruneCueAnchors();

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

    // --- muted fixtures go dark, whatever the looks say ---
    if (st.muted.size > 0) {
      for (const ho of headOrder) {
        if (!st.muted.has(ho.fixtureId)) continue;
        const o = heads.get(ho.key)!;
        o.dimmer = 0;
        o.white = 0;
        o.strobe = 0;
        o.ringFx = 0;
        o.haze = 0;
        o.motorMode = 'off';
        o.motorValue = 0;
        o.macro = null;
      }
    }

    // --- identify: full white, overriding everything including blackout ---
    if (st.identify) {
      for (const ho of headOrder) {
        if (ho.fixtureId !== st.identify) continue;
        const o = heads.get(ho.key)!;
        o.dimmer = 1;
        o.white = 1;
        o.r = 1;
        o.g = 1;
        o.b = 1;
        o.strobe = 0;
        o.macro = null; // derbies: let the quantiser pick white
        if (ho.kind === 'hazer') o.haze = 0; // never identify by hazing the room
      }
    }

    // --- per-fixture base aim: FOCUS for moving heads ---
    // A look's pan/tilt is a delta from centre, applied on top of the
    // fixture's own base. Focus 24 movers individually and a look that sweeps
    // pan sweeps around each one's focus instead of flattening them all to the
    // same angle. Base 0.5 (the default) makes this arithmetically identical
    // to having no base at all, so existing shows are untouched.
    for (const f of p.fixtures) {
      const bp = f.pan ?? 0.5;
      const bt = f.tilt ?? 0.5;
      if (bp === 0.5 && bt === 0.5) continue;
      for (let i = 0; ; i++) {
        const o = heads.get(`${f.id}:${i}`);
        if (!o) break;
        o.pan = clamp(bp + (o.pan - 0.5));
        o.tilt = clamp(bt + (o.tilt - 0.5));
      }
    }

    // --- render to DMX buffers ---
    const buffers = new Map<string, Uint8Array>();
    for (const u of p.universes) buffers.set(u.id, new Uint8Array(512));
    for (const f of p.fixtures) {
      const buf = buffers.get(f.universeId);
      if (!buf) continue;
      const base = f.address - 1;
      // Object.hasOwn on BOTH lookups. These are plain objects built from JSON,
      // so a profileId of "toString" or "constructor" otherwise resolves to an
      // inherited function: truthy enough to pass the guard, then `channels` is
      // undefined, `base + undefined > 512` is NaN > 512 which is false, and the
      // render throws — taking the whole tick with it while project echoes kept
      // flowing, so the UI confirmed edits the frozen rig never saw. The Rust
      // core resolves through a HashMap and simply skips the fixture; skipping
      // here is what keeps the two engines in step. Same reasoning as the cue
      // step lookup in resolveCue().
      const prof = Object.hasOwn(PROFILES, f.profileId) ? PROFILES[f.profileId] : undefined;
      // One fixture must never be able to stop the show. Anything unexpected
      // inside a profile's own render code costs that fixture, not the tick.
      try {
        if (prof) {
          if (base < 0 || base + prof.channels > 512) continue;
          const hp = prof.heads.map((_, i) => heads.get(`${f.id}:${i}`)!);
          prof.render(hp, buf, base);
          continue;
        }
        const cp =
          p.profiles && Object.hasOwn(p.profiles, f.profileId) ? p.profiles[f.profileId] : undefined;
        if (!cp) continue;
        if (base < 0 || base + cp.footprint > 512) continue;
        const hp = cp.heads.map((_, i) => heads.get(`${f.id}:${i}`)!);
        renderImported(f.profileId, cp, hp, buf, base);
      } catch (e) {
        if (!brokenFixtures.has(f.id)) {
          brokenFixtures.add(f.id);
          console.error(`[renderer] fixture "${f.id}" (${f.profileId}) failed to render — skipping it`, e);
        }
      }
    }

    // --- muted fixtures: zero their whole channel span. Zeroing the
    //     resolved params is not enough — a profile can emit raw colour with
    //     a separate dimmer, and a fixture that is misbehaving is exactly the
    //     one you cannot trust to honour its own dimmer channel. ---
    if (st.muted.size > 0) {
      for (const f of p.fixtures) {
        if (!st.muted.has(f.id)) continue;
        const buf = buffers.get(f.universeId);
        if (!buf) continue;
        const prof = PROFILES[f.profileId];
        const width = prof ? prof.channels : p.profiles?.[f.profileId]?.footprint ?? 0;
        const base = f.address - 1;
        for (let i = 0; i < width; i++) {
          if (base + i >= 0 && base + i < 512) buf[base + i] = 0;
        }
      }
    }

    // --- raw channel overrides: last word, after every fixture render ---
    if (st.overrides.size > 0) {
      for (const [uid, chans] of st.overrides) {
        const buf = buffers.get(uid);
        if (!buf) continue;
        for (const [ch, v] of chans) {
          if (ch >= 0 && ch < 512) buf[ch] = v;
        }
      }
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
      // Round to 3 decimals before the wire — previz-only floats at full
      // precision are 17-19 chars each and dominate the snapshot. Identical to
      // core/src/renderer.rs (all values 0..1, so Math.round matches Rust's
      // round-half-away-from-zero), so parity holds.
      const q = (v: number): number => Math.round(v * 1000) / 1000;
      const snap: HeadSnap = {
        f: ho.fixtureId, h: ho.head,
        r: q(r), g: q(g), b: q(b), i: q(i),
        st: q(o.strobe), ring, mm: o.motorMode, mv: q(o.motorValue),
        pan: q(o.pan), tilt: q(o.tilt),
      };
      // only when a look drives it — absent keeps the profile's beam angle
      if (o.zoom !== null) snap.zm = q(o.zoom);
      if (mc && mc.length) snap.mc = mc;
      return snap;
    });

    return { buffers, heads: headSnaps, layers: layerSnaps, beat };
  }
}
