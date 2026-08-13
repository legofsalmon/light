import { clamp } from '../shared/types.ts';

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

  /** Snap the beat phase to a downbeat now (Resolume resync). */
  resync(t = performance.now()): void {
    this.anchorBeat = Math.ceil(this.beatAt(t));
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
