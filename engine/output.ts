// The transmit gate: whether rendered frames actually reach the wire.
//
// Distinct from blackout, and deliberately so. Blackout is a SHOW state — the
// rig is dark because the engine is transmitting frames of zeros, and it is the
// transmitting that holds it dark. This is a TRANSPORT state: offline, nothing
// leaves the machine at all, so LIGHT can sit on a working network next to
// whatever else is patched there without fighting it for the rig.
//
// It starts OFF on every boot and is never saved. A show file that arrived by
// email, the demo opened to look around, a laptop woken in a venue where
// someone else is mid-patch — none of them may put DMX on a network until an
// operator says so.
//
// Going offline sends a few frames of zeros before falling silent, because
// Art-Net and sACN nodes hold the last frame they received: simply stopping
// would leave the rig lit at whatever it was showing. UDP drops frames, so it
// is sent more than once.
//
// Mirrors core/src/output.rs. The two must decide identically.

/** What a tick puts on the wire. */
export type Wire = 'show' | 'dark' | 'silent';

/** Frames of zeros sent on the way out. Three at 40 Hz is 75 ms. */
export const GO_DARK_FRAMES = 3;

export class OutputGate {
  private live = false;
  private goDark = 0;

  isLive(): boolean {
    return this.live;
  }

  /** Follow the engine state's gate. Going live cancels any go-dark frames
   *  still pending: the show is about to be sent anyway, and a stray zero
   *  frame after "go live" is a visible flash. */
  set(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.goDark = live ? 0 : GO_DARK_FRAMES;
  }

  /** What this tick sends. Call once per tick, before the per-universe loop —
   *  it consumes one go-dark frame. */
  tick(): Wire {
    if (this.live) return 'show';
    if (this.goDark > 0) {
      this.goDark--;
      return 'dark';
    }
    return 'silent';
  }
}
