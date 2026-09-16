// The drawn set (design 3.3, #31).
//
// Before this, every icon in the console was a Unicode character picked for
// looking roughly right: ◀ ▶ beside ‹ ›, × beside ✕, ⏸ ☆ ✕, and ◎ ⤨ ↔ ◇ ⇄ on
// the spread row. Each comes from a different face at a different weight and
// optical size, several have an emoji presentation the font stack may or may
// not prefer, and none of them line up with each other or with the type. A
// glyph that renders as a flat line drawing on the Mac and a colour emoji on
// the tablet at front of house is not a glyph, it is a surprise.
//
// So: one set, drawn on a 12-grid, one stroke weight, taking its colour from
// the text around it. Twenty-five shapes — seventeen the app uses everywhere,
// and the eight spread bases, which are the one place a picture genuinely beats
// a word because they describe a direction across a rig.
//
// Sizing and weight are tokens (--size-icon, --size-icon-touch,
// --size-icon-stroke) applied by the `.glyph` rule in theme.css, so a glyph
// scales with the desk rather than with a number typed at each call site.

import React from 'react';

/** Every glyph the app may draw. Adding one here is the only way to add one. */
export type GlyphName =
  | 'bolt'
  | 'chain'
  | 'play'
  | 'stop'
  | 'hold'
  | 'corner'
  | 'find'
  | 'lock'
  | 'clear'
  | 'prev'
  | 'next'
  | 'add'
  | 'more'
  | 'chevron'
  | 'pin'
  | 'home'
  | 'tray'
  | 'cog'
  | 'import'
  | 'readdress'
  | 'swap'
  | 'sort-up'
  | 'sort-down'
  | 'tick'
  | 'warn'
  | 'mirror'
  | 'fold-centre'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'save'
  | 'spread-order'
  | 'spread-x'
  | 'spread-y'
  | 'spread-z'
  | 'spread-radial'
  | 'spread-shuffle'
  | 'spread-row'
  | 'spread-col';

/** What each one is called when it is read aloud, and in a tooltip that has no
 *  words of its own. The wording is the app's, not the icon's: `steps`, not
 *  `chain`. */
const NAMES: Record<GlyphName, string> = {
  bolt: 'flash',
  chain: 'steps',
  play: 'plays',
  stop: 'clears every layer',
  hold: 'held',
  corner: 'still on stage',
  find: 'find',
  lock: 'locked',
  clear: 'clear',
  prev: 'previous',
  next: 'next',
  add: 'add',
  more: 'more',
  chevron: 'open',
  pin: 'pinned',
  home: 'home',
  tray: 'the tray',
  cog: 'settings',
  import: 'import a file',
  readdress: 're-address',
  swap: 'swap the order',
  'sort-up': 'sorted up',
  'sort-down': 'sorted down',
  tick: 'this one',
  warn: 'needs attention',
  mirror: 'mirrored — the ends in step, meeting in the middle',
  'fold-centre': 'the middle leads',
  'rotate-cw': 'clockwise',
  'rotate-ccw': 'anticlockwise',
  save: 'keep it for reuse',
  'spread-order': 'in patch order',
  'spread-x': 'left to right',
  'spread-y': 'bottom to top',
  'spread-z': 'upstage to downstage',
  'spread-radial': 'out from the middle',
  'spread-shuffle': 'scattered',
  'spread-row': 'along each fixture’s pixel rows',
  'spread-col': 'down each fixture’s pixel columns',
};

// Two builders so the shapes below read as shapes. `S` strokes (the stroke
// weight is the token, applied in CSS), `F` fills.
const S = (d: React.ReactNode) => (
  <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">{d}</g>
);
const F = (d: React.ReactNode) => <g fill="currentColor" stroke="none">{d}</g>;

const SHAPES: Record<GlyphName, React.ReactNode> = {
  // a flash look: held while the pad is held
  bolt: F(<path d="M7 1 3 6.6h2.4L5 11l4-5.6H6.6L7 1z" />),
  // a steps look: a look that plays other looks in order. Two links, because
  // one rounded stroke reads as a squiggle at 12px.
  chain: S(
    <>
      <rect x="0.9" y="4.3" width="5.4" height="3.4" rx="1.7" />
      <rect x="5.7" y="4.3" width="5.4" height="3.4" rx="1.7" />
    </>,
  ),
  // this column has something to fire
  play: F(<path d="M3.5 2 10 6l-6.5 4V2z" />),
  // firing this column clears every layer — a cue in its own right
  stop: F(<rect x="3" y="3" width="6" height="6" rx="0.6" />),
  // the rig is repeating one frame
  hold: F(
    <>
      <rect x="3.2" y="2.5" width="1.8" height="7" rx="0.6" />
      <rect x="7" y="2.5" width="1.8" height="7" rx="0.6" />
    </>,
  ),
  // a corner mark: what is on stage is not what this pad holds
  corner: F(<path d="M12 0v5L7 0h5z" />),
  find: S(
    <>
      <circle cx="5.2" cy="5.2" r="3.4" />
      <path d="M7.8 7.8 10.6 10.6" />
    </>,
  ),
  lock: S(
    <>
      <rect x="2.4" y="5.4" width="7.2" height="5.1" rx="1.1" />
      <path d="M4.2 5.4V4a1.8 1.8 0 0 1 3.6 0v1.4" />
    </>,
  ),
  clear: S(<path d="M3 3l6 6M9 3l-6 6" />),
  prev: S(<path d="M7.5 2.5 4 6l3.5 3.5" />),
  next: S(<path d="M4.5 2.5 8 6l-3.5 3.5" />),
  add: S(<path d="M6 2.5v7M2.5 6h7" />),
  more: F(
    <>
      <circle cx="2.6" cy="6" r="1.05" />
      <circle cx="6" cy="6" r="1.05" />
      <circle cx="9.4" cy="6" r="1.05" />
    </>,
  ),
  chevron: S(<path d="M2.5 4.5 6 8l3.5-3.5" />),
  // A thumbtack seen from the side: a solid head, a collar, a needle. Tilted
  // with an open head it was a magnifying glass, which `find` already is.
  pin: F(
    <>
      <circle cx="6" cy="3" r="2.1" />
      <rect x="3.4" y="4.9" width="5.2" height="1.3" rx="0.5" />
      <rect x="5.5" y="6.2" width="1" height="4.4" rx="0.5" />
    </>,
  ),
  home: S(<path d="M2.4 6 6 2.6 9.6 6M3.6 5.2v4.4h4.8V5.2" />),
  // Settings. Not in the design's list of twenty-five, which is an omission
  // rather than an instruction: the cog is the one affordance every operator
  // already knows, and `more` (three dots) means "more actions here", not
  // "the settings for the whole desk".
  cog: S(
    <>
      <circle cx="6" cy="6" r="1.9" />
      <path d="M6 1.3v1.3M6 9.4v1.3M1.3 6h1.3M9.4 6h1.3M2.7 2.7l.9.9M8.4 8.4l.9.9M9.3 2.7l-.9.9M3.6 8.4l-.9.9" />
    </>,
  ),
  // Bringing a file in: an arrow into a tray. The rig page's import verb, and
  // the mark beside a profile that came from a file rather than the library.
  import: S(
    <>
      <path d="M6 1.6v5.2" />
      <path d="M3.8 4.8 6 7l2.2-2.2" />
      <path d="M2.2 8.4v1a1 1 0 0 0 1 1h5.6a1 1 0 0 0 1-1v-1" />
    </>,
  ),
  // Re-address: the same run of channels, moved along.
  readdress: S(
    <>
      <path d="M1.6 4.2h5.6" />
      <path d="M5.4 2.4 7.2 4.2 5.4 6" />
      <path d="M10.4 7.8H4.8" />
      <path d="M6.6 6 4.8 7.8l1.8 1.8" />
    </>,
  ),
  // Swap two things over — the chase order's reorder key.
  swap: S(
    <>
      <path d="M2 4.2h8" />
      <path d="M8.2 2.4 10 4.2 8.2 6" />
      <path d="M10 7.8H2" />
      <path d="M3.8 6 2 7.8l1.8 1.8" />
    </>,
  ),
  tick: S(<path d="M2.4 6.4 4.9 8.9 9.6 3.4" />),
  // Something is half-done or half-known — a binding that only partly answers,
  // a value the app cannot vouch for. Not the blackout family's red: this is
  // amber's shape, and it takes amber from the text around it.
  warn: S(
    <>
      <path d="M6 1.9 11 10.4H1L6 1.9z" />
      <path d="M6 5.2v2.1" />
      <path d="M6 8.9v.05" />
    </>,
  ),
  // Spread folds. Mirror: the two ends move in step and meet in the middle —
  // two arrows converging on a centre line.
  mirror: S(
    <>
      <path d="M6 2.4v7.2" />
      <path d="M1.4 6h3M3.2 4.4 4.8 6 3.2 7.6" />
      <path d="M10.6 6h-3M8.8 4.4 7.2 6l1.6 1.6" />
    </>,
  ),
  // Centre: the middle leads and the ends trail — a filled middle between two
  // lighter wings.
  'fold-centre': F(
    <>
      <path d="M6 2.6 9.4 6 6 9.4 2.6 6 6 2.6z" />
      <rect x="0.8" y="5.3" width="1.3" height="1.4" rx="0.4" opacity="0.45" />
      <rect x="9.9" y="5.3" width="1.3" height="1.4" rx="0.4" opacity="0.45" />
    </>,
  ),
  // Rotation. One arc and its head; the other direction is the same drawing
  // mirrored, so the two never disagree about their weight.
  'rotate-cw': S(
    <>
      <path d="M9.6 6.4A3.7 3.7 0 1 1 7.9 2.9" />
      <path d="M7.4 1.4 9.3 3 7.5 4.7" />
    </>,
  ),
  'rotate-ccw': S(
    <>
      <path d="M2.4 6.4A3.7 3.7 0 1 0 4.1 2.9" />
      <path d="M4.6 1.4 2.7 3 4.5 4.7" />
    </>,
  ),
  // Keep for reuse: a bookmark ribbon — kept, not favourited.
  save: S(<path d="M3.4 1.8h5.2v8.4L6 8.2l-2.6 2V1.8z" />),
  'sort-up': F(<path d="M6 3.2 9.2 8H2.8L6 3.2z" />),
  'sort-down': F(<path d="M6 8.8 2.8 4h6.4L6 8.8z" />),
  // the desk's pull-out, not a hamburger: a drawer with a handle
  tray: S(
    <>
      <rect x="2" y="3.4" width="8" height="5.2" rx="1" />
      <path d="M4.6 6h2.8" />
    </>,
  ),

  // --- the eight spread bases. Each says which way the wave crosses the rig.
  'spread-order': F(
    <>
      <rect x="1.6" y="5.2" width="1.6" height="1.6" rx="0.4" />
      <rect x="4.2" y="5.2" width="1.6" height="1.6" rx="0.4" opacity="0.75" />
      <rect x="6.8" y="5.2" width="1.6" height="1.6" rx="0.4" opacity="0.5" />
      <rect x="9.4" y="5.2" width="1.6" height="1.6" rx="0.4" opacity="0.3" />
    </>,
  ),
  'spread-x': S(<path d="M2 6h8M7.6 3.6 10 6l-2.4 2.4" />),
  'spread-y': S(<path d="M6 10V2M3.6 4.4 6 2l2.4 2.4" />),
  // Upstage to downstage. Bars that widen and brighten as they come forward —
  // the same fading family as the other three pixel spreads, saying depth
  // where an arrow on its own only said down.
  'spread-z': F(
    <>
      <rect x="4.2" y="2.4" width="3.6" height="1.4" rx="0.5" opacity="0.35" />
      <rect x="2.9" y="5.3" width="6.2" height="1.4" rx="0.5" opacity="0.6" />
      <rect x="1.6" y="8.2" width="8.8" height="1.4" rx="0.5" />
    </>,
  ),
  'spread-radial': S(
    <>
      <circle cx="6" cy="6" r="1.2" />
      <circle cx="6" cy="6" r="4" opacity="0.55" />
    </>,
  ),
  'spread-shuffle': F(
    <>
      <circle cx="3" cy="8.6" r="1" />
      <circle cx="5.4" cy="3.4" r="1" />
      <circle cx="8.2" cy="7.4" r="1" />
      <circle cx="9.6" cy="3" r="1" />
    </>,
  ),
  'spread-row': F(
    <>
      <rect x="1.8" y="3" width="8.4" height="1.5" rx="0.5" />
      <rect x="1.8" y="5.25" width="8.4" height="1.5" rx="0.5" opacity="0.6" />
      <rect x="1.8" y="7.5" width="8.4" height="1.5" rx="0.5" opacity="0.35" />
    </>,
  ),
  'spread-col': F(
    <>
      <rect x="3" y="1.8" width="1.5" height="8.4" rx="0.5" />
      <rect x="5.25" y="1.8" width="1.5" height="8.4" rx="0.5" opacity="0.6" />
      <rect x="7.5" y="1.8" width="1.5" height="8.4" rx="0.5" opacity="0.35" />
    </>,
  ),
};

/**
 * One glyph.
 *
 * Decorative by default — most of these sit beside a word that already says it,
 * and a screen reader repeating "flash flash" is worse than silence. Pass
 * `alone` where the glyph IS the label (a key with no word in it), and it takes
 * the name above instead.
 */
export function Glyph({ name, alone = false, className = '' }: {
  name: GlyphName;
  /** the glyph carries the meaning by itself — name it for a screen reader */
  alone?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      className={`glyph ${className}`}
      viewBox="0 0 12 12"
      focusable="false"
      {...(alone ? { role: 'img', 'aria-label': NAMES[name] } : { 'aria-hidden': true })}
    >
      {SHAPES[name]}
    </svg>
  );
}

/** The name a glyph reads as, for a tooltip that has no words of its own. */
export const glyphName = (name: GlyphName): string => NAMES[name];

/** Every name, for the test that holds the set against its drawings. */
export const GLYPH_NAMES = Object.keys(SHAPES) as GlyphName[];
