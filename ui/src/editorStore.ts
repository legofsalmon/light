// The look editor's own screen state — which feature a part is showing, and
// which effect has its spread open.
//
// None of it is show data and none of it reaches the engine: it is where the
// operator last was, remembered while the app is up so flicking between pads
// does not re-fold everything. It lives here rather than in store.ts because
// store.ts is the show and the wire, and because a re-render of the grid has
// no business happening when a disclosure opens in the editor.

import { create } from 'zustand';

/** The five families the editor's part body offers, and the four the effects
 *  catalogue files its presets under (fxLibrary.ts) — one vocabulary, so
 *  "Position" means the same thing in both places. */
export type Feature = 'intensity' | 'colour' | 'position' | 'beam' | 'haze';

export const FEATURE_LABEL: Record<Feature, string> = {
  intensity: 'Intensity',
  colour: 'Colour',
  position: 'Position',
  beam: 'Beam',
  haze: 'Haze',
};

/** The effect whose spread the plan is numbering (A39, design 2.6): opening
 *  the disclosure — or just running the pointer over the folded line — puts
 *  the group's heads on the plan in the order the spread will run them. It is
 *  an address, not a copy: the effect itself is read from the project each
 *  frame, so changing a basis re-numbers without anything here being told. */
export type SpreadPreview = { lookId: string; partId: string; effectId: string };

type EditorStore = {
  /** the feature each part is showing, by part id */
  feature: Record<string, Feature>;
  setFeature: (partId: string, f: Feature) => void;
  /** effect ids whose spread controls are open */
  spreadOpen: Record<string, boolean>;
  toggleSpread: (effectId: string) => void;
  /** what the plan is numbering: the open disclosure, or the line under the
   *  pointer while one is hovered */
  spreadPreview: SpreadPreview | null;
  setSpreadPreview: (p: SpreadPreview | null) => void;
  /** the four per-look offset dials (A41), by look id — each a position the
   *  editor fans out over the look's parts through the soft nudge path.
   *  Screen state only: nothing here reaches the engine, and a look with no
   *  nudges left on it reads as neutral however these were last left. */
  offsets: Record<string, LookOffsets>;
  setOffset: (lookId: string, dial: OffsetDial, v: number) => void;
  clearOffsets: (lookId: string) => void;
};

/** The four dials, and the value at which each does nothing. */
export type OffsetDial = 'hue' | 'dimmer' | 'pan' | 'size';
export type LookOffsets = Record<OffsetDial, number>;
export const OFFSET_NEUTRAL: LookOffsets = { hue: 0, dimmer: 1, pan: 0, size: 1 };

export const useEditorStore = create<EditorStore>((set) => ({
  feature: {},
  setFeature: (partId, f) => set((s) => ({ feature: { ...s.feature, [partId]: f } })),
  spreadOpen: {},
  toggleSpread: (effectId) =>
    set((s) => ({ spreadOpen: { ...s.spreadOpen, [effectId]: !s.spreadOpen[effectId] } })),
  spreadPreview: null,
  setSpreadPreview: (spreadPreview) => set({ spreadPreview }),
  offsets: {},
  setOffset: (lookId, dial, v) =>
    set((s) => ({
      offsets: { ...s.offsets, [lookId]: { ...OFFSET_NEUTRAL, ...s.offsets[lookId], [dial]: v } },
    })),
  clearOffsets: (lookId) =>
    set((s) => {
      if (!s.offsets[lookId]) return {};
      const offsets = { ...s.offsets };
      delete offsets[lookId];
      return { offsets };
    }),
}));
