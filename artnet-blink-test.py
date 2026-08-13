#!/usr/bin/env python3
"""
Art-Net blink test for the light rig — verify the physical patch, one fixture at a time.

Steps through every fixture with an on-stage test pattern and tells you what you
should be seeing, plus what it means if you aren't. No dependencies (stdlib only).

Patch under test (see rig guide / qlcplus/README.md):
  Universe 0  Octostrip MK2 controller, 192CH pixel mode (8 strips x 8 RGB sections)
  Universe 1  Derby 1 @001, Derby 2 @011 (04Ch mode)
              KAM Partybar 1 @021, Partybar 2 @051 (20CH mode)
              Hazer @101 (2ch; only tested with --hazer)

Usage:
  python3 artnet-blink-test.py                    # interactive, broadcast 2.255.255.255
  python3 artnet-blink-test.py --target 2.0.0.11  # unicast (reaches ONE box only)
  python3 artnet-blink-test.py --auto 4           # non-interactive, 4s per step
  python3 artnet-blink-test.py --skip-octo        # effects universe only
  python3 artnet-blink-test.py --hazer            # include a gentle hazer pulse

Both universes are transmitted continuously for the whole run (idle one at zero),
so fixtures never drop to sound-active mode mid-test. Ctrl-C at any point sends
blackout to both universes before exiting. No strobe effects are used anywhere.
"""

import argparse
import socket
import struct
import sys
import threading
import time

PORT = 6454

# ---------- fixture addressing (0-based buffer offsets; DMX addr - 1) ----------
DERBY1, DERBY2 = 0, 10          # 4ch: colour macro, strobe, motor, white ring
BAR1, BAR2 = 20, 50             # 20ch: per par (R, G, B, dimmer, flash) x 4
HAZER = 100                     # 2ch: output, fan

D_RED, D_GREENBLUE, D_RGBW = 13, 118, 208   # derby colour-macro band midpoints
MOTOR_SPIN = 200                             # >=128 rotates


def art_dmx(universe, data):
    """Build an ArtDmx packet for a 15-bit port address."""
    return (b"Art-Net\x00"
            + struct.pack("<H", 0x5000)          # OpDmx
            + bytes([0, 14])                     # protocol 14
            + bytes([0, 0])                      # sequence off, physical 0
            + bytes([universe & 0xFF, (universe >> 8) & 0x7F])
            + struct.pack(">H", 512)
            + bytes(data))


class Sender(threading.Thread):
    """Transmits both universes at a fixed rate; animators mutate the buffers."""

    def __init__(self, target, fps):
        super().__init__(daemon=True)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.target = target
        self.frame_time = 1.0 / fps
        self.animators = {0: None, 1: None}   # universe -> fn(t) -> 512 values
        self.running = True
        self.t0 = time.time()

    def run(self):
        while self.running:
            t = time.time() - self.t0
            for uni in (0, 1):
                fn = self.animators[uni]
                data = fn(t) if fn else [0] * 512
                try:
                    self.sock.sendto(art_dmx(uni, data), (self.target, PORT))
                except OSError as e:
                    print(f"\n  !! network send failed: {e}", file=sys.stderr)
                    self.running = False
            time.sleep(self.frame_time)

    def set(self, universe, fn):
        self.animators[universe] = fn

    def blackout_and_stop(self):
        self.animators = {0: None, 1: None}
        for _ in range(8):                     # a burst of zero frames, then stop
            for uni in (0, 1):
                try:
                    self.sock.sendto(art_dmx(uni, [0] * 512), (self.target, PORT))
                except OSError:
                    pass
            time.sleep(0.03)
        self.running = False


# ---------- animators (each returns a fresh 512-channel frame) ----------

def octo_all(r, g, b):
    def fn(t):
        d = [0] * 512
        for px in range(64):
            d[px * 3:px * 3 + 3] = (r, g, b)
        return d
    return fn


def octo_strip_walk(t):
    d = [0] * 512
    strip = int(t) % 8                          # 1s per strip
    base = strip * 24
    for s in range(8):
        d[base + s * 3] = 255                   # red
    return d


def octo_pixel_chase(t):
    d = [0] * 512
    px = int(t * 8) % 64                        # 8 sections/second
    d[px * 3:px * 3 + 3] = (255, 255, 255)
    return d


def octo_rgb_steps(t):
    rgb = [(255, 0, 0), (0, 255, 0), (0, 0, 255)][int(t) % 3]
    return octo_all(*rgb)(t)


def derby_blink(base):
    def fn(t):
        d = [0] * 512
        d[base] = D_RED if int(t * 2) % 2 == 0 else 0   # 2 Hz colour toggle
        return d
    return fn


def derby_motor(base):
    def fn(t):
        d = [0] * 512
        d[base] = D_RGBW
        d[base + 2] = MOTOR_SPIN
        return d
    return fn


def bar_par_walk(base):
    def fn(t):
        d = [0] * 512
        par = int(t) % 4                        # 1s per par
        o = base + par * 5
        d[o:o + 4] = (255, 255, 255, 255)       # R G B dimmer; flash stays 0
        return d
    return fn


def bar_rgb_steps(base):
    def fn(t):
        d = [0] * 512
        r, g, b = [(255, 0, 0), (0, 255, 0), (0, 0, 255)][int(t) % 3]
        for par in range(4):
            o = base + par * 5
            d[o:o + 4] = (r, g, b, 255)
        return d
    return fn


def hazer_pulse(t):
    d = [0] * 512
    d[HAZER] = 80                               # gentle output
    d[HAZER + 1] = 128                          # medium fan
    return d


# ---------- test sequence ----------

def steps(args):
    s = []
    if not args.skip_octo:
        s += [
            (0, "OCTOSTRIP: all sections lit", octo_all(120, 120, 120),
             "All 64 sections glow white at ~50%.",
             "Nothing at all: controller not in ArtNet mode / wrong universe (needs 0) / "
             "network unreachable. Some strips dark: check that strip's XLR to the controller."),
            (0, "OCTOSTRIP: strip walk", octo_strip_walk,
             "One whole strip solid red at a time, stepping 1-8 in patch order (1s each).",
             "Strips lighting out of order: plugged into the wrong controller sockets — "
             "either re-plug or renumber the fixtures in Resolume."),
            (0, "OCTOSTRIP: pixel chase", octo_pixel_chase,
             "A single white dot snakes along each strip section 1-8, strip by strip.",
             "Dot runs backwards on a strip: that strip is mounted flipped — rotate its "
             "fixture 180 degrees in Resolume's Input Selection rather than re-rigging."),
            (0, "OCTOSTRIP: colour check", octo_rgb_steps,
             "Everything steps RED -> GREEN -> BLUE, 1s each.",
             "Colours swapped: controller not in 192CH mode (or LED Mode not 1.0M) — "
             "fix in the controller menu."),
        ]
    if not args.skip_effects:
        s += [
            (1, "DERBY 1 @001: blink", derby_blink(DERBY1),
             "Derby 1 — and ONLY Derby 1 — pulses red twice a second. No movement.",
             "Both derbies pulse: both set to address 001. Derby 2 pulses instead: "
             "addresses swapped. Runs an auto show: unit is in 01Ch mode, set dMH -> 04Ch."),
            (1, "DERBY 1 @001: motor", derby_motor(DERBY1),
             "Derby 1 lights RGBW steady and the beams ROTATE.",
             "Lit but frozen: motor channel not reaching it — likely wrong mode or a "
             "1-channel address offset (check address is exactly A001)."),
            (1, "DERBY 2 @011: blink", derby_blink(DERBY2),
             "Only Derby 2 pulses red.",
             "Nothing: address not A011. Derby 1 responds: addresses swapped."),
            (1, "DERBY 2 @011: motor", derby_motor(DERBY2),
             "Derby 2 lights RGBW steady, beams rotate.", None),
            (1, "PARTYBAR 1 @021: par walk", bar_par_walk(BAR1),
             "Bar 1's four pars light white one at a time, 1-4 (1s each). Bar 2 dark.",
             "Only some pars, or spill onto bar 2's pars: bar not in 20CH mode (12CH "
             "shifts everything) — set mode 20CH, address d021. Walk runs 4-1: that's "
             "just which way the bar is hung."),
            (1, "PARTYBAR 1 @021: colour check", bar_rgb_steps(BAR1),
             "All four pars step RED -> GREEN -> BLUE together.", None),
            (1, "PARTYBAR 2 @051: par walk", bar_par_walk(BAR2),
             "Bar 2's pars walk 1-4; bar 1 stays dark.",
             "Bar 1 responds: addresses swapped (d021 vs d051)."),
            (1, "PARTYBAR 2 @051: colour check", bar_rgb_steps(BAR2),
             "All four pars step R -> G -> B.", None),
        ]
    if args.hazer:
        s += [
            (1, "HAZER @101: gentle pulse", hazer_pulse,
             "Light haze output, medium fan (if warmed up — heaters need a few minutes).",
             "Nothing: check the hazer's channel count in its manual (some are 1ch), "
             "its address (101), and that DMX mode overrides its onboard timer."),
        ]
    return s


BOLD, DIM, RESET = ("\033[1m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "", "")


def main():
    p = argparse.ArgumentParser(description="Art-Net patch blink test for the light rig")
    p.add_argument("--target", default="2.255.255.255",
                   help="destination IP (default 2.255.255.255 broadcast; unicast reaches one box only)")
    p.add_argument("--fps", type=float, default=30, help="Art-Net frame rate (default 30)")
    p.add_argument("--auto", type=float, metavar="SECONDS",
                   help="non-interactive: run each step for SECONDS instead of waiting for Enter")
    p.add_argument("--skip-octo", action="store_true", help="skip universe 0 (Octostrip) tests")
    p.add_argument("--skip-effects", action="store_true", help="skip universe 1 (derby/bar) tests")
    p.add_argument("--hazer", action="store_true", help="include a gentle hazer pulse (off by default)")
    args = p.parse_args()

    seq = steps(args)
    if not seq:
        print("Nothing to test (both universes skipped).")
        return

    print(f"""{BOLD}Art-Net blink test{RESET} -> {args.target}:{PORT} at {args.fps:.0f} fps
Universe 0: Octostrip controller (ArtNet / 1.0M / 192CH / universe 0)
Universe 1: node -> Derby @001/@011 (04Ch) -> Bars @021/@051 (20CH) -> Hazer @101
{DIM}Quit Resolume/QLC+ output first — two senders on one universe will fight.
No strobe effects are used. Ctrl-C any time = blackout + exit.{RESET}
""")

    sender = Sender(args.target, args.fps)
    sender.start()

    try:
        for i, (uni, title, fn, expect, hint) in enumerate(seq, 1):
            sender.t0 = time.time()            # restart animation clock per step
            sender.set(0, None)
            sender.set(1, None)
            sender.set(uni, fn)
            print(f"{BOLD}[{i}/{len(seq)}] U{uni}  {title}{RESET}")
            print(f"      expect: {expect}")
            if hint:
                print(f"      {DIM}if not: {hint}{RESET}")
            if args.auto:
                time.sleep(args.auto)
            else:
                if input(f"      {DIM}Enter = next, q = quit ... {RESET}").strip().lower() == "q":
                    break
            print()
        print(f"{BOLD}Done — sending blackout.{RESET}")
    except (KeyboardInterrupt, EOFError):
        print(f"\n{BOLD}Interrupted — sending blackout.{RESET}")
    finally:
        sender.blackout_and_stop()
        sender.join(timeout=2)


if __name__ == "__main__":
    main()
