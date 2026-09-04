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
}
