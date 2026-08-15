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
        assert_eq!(p.layers.len(), 4);
    }
}
