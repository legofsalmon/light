// The pointer, written down once.
//
// The keyboard has had one list since backlog #8 (shortcuts.ts) and a test that
// reads the published table back out of the documentation. The pointer never
// did — and the pointer is where this desk keeps most of what it can do: every
// menu, every clear and every place-a-look is a right-click, a hold or a drag,
// and none of it was written down anywhere a person could find it. A gesture
// nobody can guess and nobody can look up does not exist.
//
// So this is the list. The sheet renders it beside the keys, and the same test
// in the engine suite reads it back out of docs/website/10-reference.md — line
// for line, word for word. Adding a gesture without documenting it fails the
// build, exactly as adding a shortcut does.
//
// Two wordings per row, because the same gesture is a different sentence
// depending on what is in the operator's hand: a mouse has a right-click and a
// fingertip does not, so it holds instead. The app already picks its words this
// way everywhere else (`touch ? 'hold' : 'right-click'`); this is that choice,
// made once, for the reference that has to agree with all of them.

/** Where a gesture is shown in the sheet. Presentation only. */
export type GestureGroup = 'On the grid' | 'Looks and lights' | 'The desk';

export type Gesture = {
  /** with a mouse or a trackpad, exactly as the published table writes it */
  pointer: string;
  /** the same gesture on glass, exactly as the published table writes it */
  touch: string;
  /** what it does, exactly as the published table describes it */
  label: string;
  group: GestureGroup;
};

/** Declared in the order the published table lists them, so the two can be
 *  compared line by line. */
export const GESTURES: Gesture[] = [
  {
    pointer: 'right-click a pad’s name',
    touch: 'hold a pad’s name',
    label: 'open that pad’s menu',
    group: 'On the grid',
  },
  {
    // The name and not the body: the body fires on pointerdown, so a pad you
    // could drag by its face would go on stage every time you reached for it.
    pointer: 'drag a pad’s name',
    touch: 'drag a pad’s name',
    label: 'move the look to another pad — the two swap what they hold',
    group: 'On the grid',
  },
  {
    pointer: 'right-click a column head',
    touch: 'hold a column head',
    label: 'rename, insert or delete that column',
    group: 'On the grid',
  },
  {
    pointer: 'click the layer’s ✕',
    touch: 'hold the layer’s ✕ until the ring fills',
    label: 'stop that layer',
    group: 'On the grid',
  },
  {
    pointer: 'click a library tile, then a pad’s name',
    touch: 'tap a library tile, then a pad’s name',
    label: 'put that look on the pad — the tile stays armed until Esc',
    group: 'Looks and lights',
  },
  {
    pointer: 'type a name on the plan',
    touch: 'type a name on the plan',
    label: 'select the lights whose names start with what you type',
    group: 'Looks and lights',
  },
  {
    pointer: 'hold the lock',
    touch: 'hold the lock',
    label: 'unlock this screen — it asks for the passcode',
    group: 'The desk',
  },
];

/** The sheet's sections, in the order it shows them. */
export const GESTURE_GROUPS: GestureGroup[] = ['On the grid', 'Looks and lights', 'The desk'];

/** The wording for the pointer actually in the operator's hand. */
export const gestureWords = (g: Gesture, touch: boolean): string => (touch ? g.touch : g.pointer);
