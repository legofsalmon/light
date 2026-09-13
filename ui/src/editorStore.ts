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

type EditorStore = {
  /** the feature each part is showing, by part id */
  feature: Record<string, Feature>;
  setFeature: (partId: string, f: Feature) => void;
  /** effect ids whose spread controls are open */
  spreadOpen: Record<string, boolean>;
  toggleSpread: (effectId: string) => void;
};

export const useEditorStore = create<EditorStore>((set) => ({
  feature: {},
  setFeature: (partId, f) => set((s) => ({ feature: { ...s.feature, [partId]: f } })),
  spreadOpen: {},
  toggleSpread: (effectId) =>
    set((s) => ({ spreadOpen: { ...s.spreadOpen, [effectId]: !s.spreadOpen[effectId] } })),
}));
