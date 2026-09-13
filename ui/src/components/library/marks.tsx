// The four marks the library draws, as inline SVG on the 12-grid.
//
// Placeholders with a purpose: design 3.3 replaces every Unicode glyph in the
// app with one set in `ui/src/glyphs.tsx` (#31), which is another lane's file.
// Until it lands these are drawn here rather than typed as ⚡ and ⛓ — the
// emoji presentation of those two is exactly what "no emoji in UI copy" is
// about, and a character that renders as a colour emoji on one machine and a
// line drawing on the next is not a corner mark. When glyphs.tsx arrives these
// four are deleted and imported from it; the shapes are already its shapes.

import React from 'react';

const Icon = ({ children, name }: { children: React.ReactNode; name: string }) => (
  <svg className="mark" viewBox="0 0 12 12" role="img" aria-label={name} focusable="false">
    {children}
  </svg>
);

/** flash — a look that holds only while the pad is held */
export const Bolt = () => (
  <Icon name="flash"><path d="M7 1 3 6.6h2.4L5 11l4-5.6H6.6L7 1z" fill="currentColor" /></Icon>
);

/** steps — a look that plays other looks in order */
export const Chain = () => (
  <Icon name="steps">
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4.6 7.4 3.3 8.7a1.9 1.9 0 0 1-2.6-2.6L2 4.8" />
      <path d="M7.4 4.6 8.7 3.3a1.9 1.9 0 0 1 2.6 2.6L10 7.2" />
      <path d="M4.7 7.3l2.6-2.6" />
    </g>
  </Icon>
);

/** find — the search field, and the no-hits chip */
export const Find = () => (
  <Icon name="find">
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="5.2" cy="5.2" r="3.4" />
      <path d="M7.8 7.8 10.6 10.6" />
    </g>
  </Icon>
);

/** add — the verb the empty library offers */
export const Add = () => (
  <Icon name="add">
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 2v8M2 6h8" />
    </g>
  </Icon>
);
