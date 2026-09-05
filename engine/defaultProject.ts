import type { Project } from '../shared/types.ts';
import defaultShow from '../shared/defaultProject.json' with { type: 'json' };
import blankShow from '../shared/blankProject.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// The first-load show: a 20-song electronic set on the full rig — 2 derbies,
// 2 party bars and a hazer on Universe 1, 8 Showtec Octostrips (64 pixels) on
// Universe 0. Each deck is one song, eight columns deep: Intro, Build, Break,
// Drop, Bridge, Peak, Outro, Blackout.
//
// It lives as JSON rather than as code building 190 looks, and BOTH engines
// read this one file — the Rust core embeds it with include_str! at compile
// time. Two hand-kept copies of a show this size would drift, and a drifting
// default is a parity failure that only shows up on a fresh install.
//
// Regenerate with scripts/build-set.mjs if the set design changes.
// ---------------------------------------------------------------------------

export function defaultProject(): Project {
  // a fresh copy each call: callers sanitise and mutate it
  return structuredClone(defaultShow) as unknown as Project;
}

/// A genuinely empty show, for "New project".
///
/// Separate from defaultProject because that one is ALSO the first-launch
/// project: emptying it would boot a fresh install into a black, contentless
/// app. "New project" used to call it, which is why creating one handed you a
/// copy of the 20-song demo with a different name.
///
/// Same one-file rule as the default: the Rust core embeds this exact JSON, so
/// the two engines cannot drift on what "blank" means.
export function blankProject(): Project {
  return structuredClone(blankShow) as unknown as Project;
}
