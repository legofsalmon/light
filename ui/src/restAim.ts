// Which way a fixture's body faces when nothing is driving it — the rest pose
// — in the fixture's own frame: y down, z toward the audience.
//
// LITERAL DATA duplicated in previz/src/scene.rs (`rest_dir`). The native stage
// window and this one draw the same rig, and for a while they disagreed on
// where a par points: below the rig height the native rested a fixture 75° from
// vertical, this one 6°, and a show's mounting tilts had been set against this
// one — a bar tuned level here stood on end there. The floor row is therefore
// the web's, and the native took it. A smoke test holds the two tables against
// each other, so a change to one that is not made to the other fails before
// anyone compares windows again.
//
// Pure, and outside the component, so the Node suite can read it.

export type RestDir = readonly [number, number, number];

/** Below this a fixture is on the floor, a case or a riser, and points forward. */
export const RIG_HEIGHT_M = 1.2;

export const REST_DIR = {
  /** a derby: down and well toward the audience, the fan's centre */
  derby: [0, -0.85, 0.52],
  /** hung above the rig height: down, tipped toward the audience */
  rigged: [0, -0.93, 0.37],
  /** on the floor, a case or a riser: nearly straight down, a touch toward the
   *  audience — the mounting tilt is what points it, and every show's tilts
   *  were set against this */
  floor: [0, -0.995, 0.0998],
} as const satisfies Record<string, RestDir>;

/** The rest direction for a fixture whose first head is `kind`, hung at `y`. */
export function restDir(kind: string | undefined, y: number): RestDir {
  if (kind === 'derby') return REST_DIR.derby;
  return y > RIG_HEIGHT_M ? REST_DIR.rigged : REST_DIR.floor;
}

/** The rotation about X that takes a body pointing straight down (-Y) onto
 *  `dir`: negative tips it toward the audience (+Z). */
export function restTiltX(dir: RestDir): number {
  return -Math.atan2(dir[2], -dir[1]);
}
