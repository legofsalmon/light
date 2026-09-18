// Whether the operating system is actually taking our packets.
//
// A send that fails is silent on the wire and, until now, silent in the app:
// the output dot read "live" for a whole evening while the kernel refused every
// frame (a Mac that had updated LIGHT in place and needed the Local Network
// permission re-evaluated by a relaunch). Nothing reached the rig and nothing
// said so. This remembers the most recent refusal for one second, so a single
// failing universe keeps it visible at 40 frames a second — a success from
// the next universe does not erase it — and it retires itself a second after
// the last refusal. A sender with no socket at all is a permanent refusal.
//
// Twin of core/src/send_health.rs; both carry the same tests. Pure, so the
// smoke suite can drive it with its own clock.

/** How long a refusal stays reported after the last failed send. Long enough
 *  that one bad universe among good ones holds the dot, short enough that a
 *  fix shows within a second. */
export const SEND_ERROR_HOLD_MS = 1000;

export class SendHealth {
  /** the message, and when it was noted — `null` when permanent (no socket) */
  private last: { msg: string; at: number | null } | null = null;

  /** A send the OS refused, with the destination and its error. */
  noteErr(msg: string, now: number): void {
    this.last = { msg, at: now };
  }

  /** No socket could be made: every send is refused until further notice. */
  notePermanent(msg: string): void {
    this.last = { msg, at: null };
  }

  /** The refusal to report right now, if any. */
  current(now: number): string | null {
    if (!this.last) return null;
    if (this.last.at === null) return this.last.msg;
    return now - this.last.at < SEND_ERROR_HOLD_MS ? this.last.msg : null;
  }
}
