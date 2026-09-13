// The Rig page's own screen state: which section the rail is on, what is being
// looked for, what the aim strip points at, and the prefix someone is typing at
// the plan.
//
// Deliberately NOT in the project store. None of this is the show — it is where
// one operator is looking on one client — and putting it beside `project` and
// `snap` would put a re-render of the 129-row table on the path of every
// snapshot. It is also why the Rig page can be unmounted and remounted without
// the store knowing anything about it.

import { create } from 'zustand';

/** The rail's entries, in the order the design lists them (2.9). */
export type RigSection = 'fixtures' | 'groups' | 'stage' | 'profiles' | 'library';

export const RIG_SECTIONS: { id: RigSection; label: string; help: string }[] = [
  { id: 'fixtures', label: 'Fixtures', help: 'what is on the truss: profile, universe, address and the pair that finds it' },
  { id: 'groups', label: 'Groups', help: 'the sets of heads looks point at, in chase order' },
  { id: 'stage', label: 'Stage', help: 'the room: its size, the truss and risers, and the musicians on the plan' },
  { id: 'profiles', label: 'Profiles', help: 'the fixture definitions this show carries, and their pixel layout' },
  { id: 'library', label: 'Library', help: 'every fixture you can patch from, and GDTF Share' },
];

type RigStore = {
  /** the rail entry the page is on — set by the rail, and by the section the
   *  table column has scrolled to */
  section: RigSection;
  /** find-as-you-type over name, address and universe */
  find: string;
  /** the plan point the aim strip aims at, by prop id */
  aimAt: string | null;
  /** what has been typed at the plan to select by name (A43); '' = nothing */
  prefix: string;
  /** which match ⌃Tab has stepped to, -1 = all of them */
  step: number;
  /** bumped by `jumpTo`, and only by `jumpTo`: the page scrolls to the section
   *  when someone asks for it, never when the scroll position reports which
   *  section it has arrived at — which would be a loop */
  jump: number;
  setSection: (s: RigSection) => void;
  jumpTo: (s: RigSection) => void;
  setFind: (q: string) => void;
  setAimAt: (id: string | null) => void;
  setPrefix: (p: string, step?: number) => void;
};

export const useRig = create<RigStore>((set) => ({
  section: 'fixtures',
  find: '',
  aimAt: null,
  prefix: '',
  step: -1,
  jump: 0,
  setSection: (section) => set({ section }),
  jumpTo: (section) => set((s) => ({ section, jump: s.jump + 1 })),
  setFind: (find) => set({ find }),
  setAimAt: (aimAt) => set({ aimAt }),
  setPrefix: (prefix, step = -1) => set({ prefix, step }),
}));
