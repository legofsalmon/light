import { BAR, clamp } from '../shared/types.ts';

/** Musical clock: continuous beat position derived from an anchor + BPM. */
export class BeatClock {
  bpm = 120;
  private anchorT = performance.now();
  private anchorBeat = 0;
  private taps: number[] = [];

  beatAt(t: number): number {
    return this.anchorBeat + ((t - this.anchorT) / 60000) * this.bpm;
  }

  /** Change tempo without a phase jump. Non-finite input is rejected outright. */
  setBpm(bpm: number, t = performance.now()): void {
    if (!Number.isFinite(bpm)) return;
    this.anchorBeat = this.beatAt(t);
    this.anchorT = t;
    this.bpm = clamp(bpm, 20, 500);
  }

  /** Set tempo AND phase together.
   *
   *  A follower knows both at once, and doing it as two calls leaves one tick
   *  where the beat is computed from the NEW tempo against the OLD anchor — a
   *  phase step every time the tempo moves, which on a MIDI clock is several
   *  times a second. Mirrors set_tempo_and_beat in core/src/clock.rs. */
  setTempoAndBeat(bpm: number, beat: number, t = performance.now()): void {
    if (!Number.isFinite(bpm) || !Number.isFinite(beat)) return;
    this.bpm = clamp(bpm, 20, 500);
    this.anchorBeat = beat;
    this.anchorT = t;
  }

  /** Make NOW the top of a bar (Resolume resync). Mirrors resync in
   *  core/src/clock.rs.
   *
   *  The nearest bar line, not the next whole beat. "Downbeat" is the first
   *  beat of a bar, and landing on any beat left the bar count — and every
   *  effect cycle longer than a beat — wherever it happened to be. Nearest
   *  rather than next because this is pressed ON the downbeat, so it should
   *  move as little as possible in either direction. */
  resync(t = performance.now()): void {
    this.anchorBeat = Math.round(this.beatAt(t) / BAR) * BAR;
    this.anchorT = t;
  }

  tap(t = performance.now()): void {
    if (this.taps.length && t - this.taps[this.taps.length - 1] > 2500) this.taps = [];
    this.taps.push(t);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length >= 2) {
      const iv = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.bpm = clamp(60000 / iv, 20, 500);
    }
    // Every tap lands on a whole beat.
    this.anchorBeat = Math.round(this.beatAt(t));
    this.anchorT = t;
  }
}
