use crate::types::Project;

/// The shipped default project — a 20-song electronic set on the full rig.
///
/// Both engines read the SAME file: the Node reference imports it, this embeds
/// it at compile time. It used to be a copy kept in step by hand, which for a
/// 190-look show is a drift waiting to happen — and a default that differs
/// between engines is a parity failure nobody sees until a fresh install.
pub fn default_project() -> Project {
    serde_json::from_str(include_str!("../../shared/defaultProject.json"))
        .expect("embedded default project must parse")
}

/// A genuinely empty show, for `New project`.
///
/// Separate from `default_project` because that one is ALSO the first-launch
/// project: emptying it would boot a fresh install into a black, contentless
/// app. "New project" used to call it, which is why creating one handed you a
/// copy of the 20-song demo with a different name — no rig cleared, no decks
/// cleared, nothing cleared but the title.
///
/// What survives is the GRID, not the show: two universes to patch into, four
/// empty layers, eight named columns and one empty deck. Eight blank headers
/// and no layers would be a worse start than the demo it replaces.
pub fn blank_project() -> Project {
    serde_json::from_str(include_str!("../../shared/blankProject.json"))
        .expect("embedded blank project must parse")
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_project_parses() {
        let p = super::default_project();
        assert_eq!(p.version, 1);
        assert_eq!(p.fixtures.len(), 13); // 2 derby, 2 bars, hazer, 8 strips
        assert_eq!(p.decks.len(), 20);
        // Four. The APC40 mk2's fifth pad row is the CONTROL row the look grid
        // draws beneath the layers (ui/src/apcFeedback.ts APC_LAYER_ROWS), so a
        // fifth layer here would be a row the surface can neither light nor
        // fire. An older default had five for exactly the opposite reason.
        assert_eq!(p.layers.len(), 4);
        // names must stay generic: what hangs on a layer depends on the rig
        for (i, l) in p.layers.iter().enumerate() {
            assert_eq!(l.name, format!("Layer {}", i + 1));
        }
    }

    /// The bug: "New project" called default_project(), so it handed you the
    /// 20-song demo with a new name. Nothing was cleared — not the decks the
    /// report was about, and not the rig either.
    #[test]
    fn a_new_project_is_actually_empty() {
        let b = super::blank_project();
        assert!(b.fixtures.is_empty(), "a new project must not inherit a rig");
        assert!(b.looks.is_empty(), "…or 190 looks");
        assert!(b.groups.is_empty());
        assert!(b.props.as_deref().unwrap_or_default().is_empty(), "…or the demo's staging");
        assert!(b.midi.is_empty(), "…or someone else's MIDI mappings");
        assert!(b.profiles.is_empty());
    }

    /// What a blank project keeps is the GRID. Eight blank headers and no
    /// layers would be a worse start than the demo it replaces.
    #[test]
    fn a_new_project_keeps_a_usable_grid() {
        let b = super::blank_project();
        let d = super::default_project();
        assert_eq!(b.layers.len(), d.layers.len(), "layers are structure, not content");
        assert!(b.layers.iter().all(|l| l.cells.iter().all(|c| c.is_none())), "cells must be empty");
        assert_eq!(b.columns.len(), d.columns.len());
        assert_eq!(b.universes.len(), d.universes.len(), "a rig needs somewhere to patch");
        assert_eq!(b.decks.len(), 1, "exactly one empty deck, not none and not twenty");
        assert_eq!(b.active_deck_id.as_deref(), Some("deck-1"));
        assert!(
            b.decks[0].cells.values().all(|c| c.iter().all(|x| x.is_none())),
            "the deck must be empty too — this is the reported bug"
        );
    }

    /// Both engines embed the same file, so "blank" cannot mean two things.
    #[test]
    fn the_blank_project_has_the_same_shape_as_the_default() {
        let b: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/blankProject.json")).unwrap();
        let d: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/defaultProject.json")).unwrap();
        let (bk, dk) = (b.as_object().unwrap(), d.as_object().unwrap());
        let mut missing: Vec<&String> = dk.keys().filter(|k| !bk.contains_key(*k)).collect();
        missing.sort();
        assert!(missing.is_empty(), "blank project is missing fields: {missing:?}");
    }

    /// Outputs are off until someone turns them on — the single most important
    /// default in the app (docs/website/09-output.md). Both templates shipped
    /// with Art-Net on, so a copy opened on a venue's WiFi broadcast two
    /// universes the moment the splash cleared, and the blank project carried
    /// the author's node labels and an OSC listener into every new show.
    #[test]
    fn neither_template_sends_dmx_until_asked() {
        for (name, p) in [("default", super::default_project()), ("blank", super::blank_project())] {
            for u in &p.universes {
                assert!(!u.artnet, "{name}: universe {} sends Art-Net out of the box", u.label);
                assert!(!u.sacn, "{name}: universe {} sends sACN out of the box", u.label);
            }
        }
        let b = super::blank_project();
        let labels: Vec<&str> = b.universes.iter().map(|u| u.label.as_str()).collect();
        assert_eq!(labels, ["Universe 1", "Universe 2"], "a blank project must not name someone else's nodes");
        assert!(!b.sync.osc_enabled, "the Resolume link is a step the operator takes, not a listener that starts itself");
    }
}
