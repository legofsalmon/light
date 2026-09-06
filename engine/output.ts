// What reaches the wire: whether anything does (the transmit gate), and which
// frame it is (the freeze hold).
//
// Both live here because both answer the same question at the same moment, and
// an operator asks them together: "is the rig following me, and if not, why
// not."
//
// ## The transmit gate
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

/** Holds the frame the rig is showing while the show carries on underneath.
 *
 *  Freeze exists for the thing every operator does mid-set: opening a look to
 *  change it, with the rig live. Every edit is live, so a half-built look is on
 *  stage while it is being built. Frozen, the wire repeats the frame it was
 *  already showing and the renderer keeps running — so the stage view, the pads
 *  and the previz all follow the edit while the room does not.
 *
 *  It holds EVERYTHING, including the raw channel check tool and find-this-
 *  light. Both are diagnostics and there is a case for letting them through,
 *  but only one of them could be: the override pass is separable and identify
 *  is baked into the render long before this. One diagnostic punching through
 *  while the other silently does not is worse than a rule that is simply true.
 *  The DMX monitor shows the held frame for the same reason: it reports what is
 *  leaving the app, and while frozen that is this.
 *
 *  Blackout and ALL STOP release it rather than being held by it — blackout
 *  always wins, and a panic a hold could swallow is not a panic.
 *
 *  Mirrors FreezeHold in core/src/output.rs. */
export class FreezeHold {
  private held = new Map<string, Uint8Array>();

  /** Substitute the held frame while frozen. Call once per tick with the
   *  buffers this tick rendered; what comes back out is what should reach the
   *  wire and the monitor.
   *
   *  Each universe latches on the first frozen tick it is present for, so a
   *  universe added mid-freeze holds from the moment it exists rather than
   *  going live on its own. */
  apply(frozen: boolean, buffers: Map<string, Uint8Array>): void {
    if (!frozen) {
      this.held.clear();
      return;
    }
    for (const [id, buf] of buffers) {
      const h = this.held.get(id);
      // A copy each way: the renderer reuses nothing between ticks today, but
      // a hold that aliased this tick's buffer would follow the show it is
      // meant to be holding if that ever changed.
      if (h) buf.set(h);
      else this.held.set(id, buf.slice());
    }
  }
}
