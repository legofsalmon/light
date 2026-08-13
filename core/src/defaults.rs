use crate::types::Project;

/// The shipped default project — Colm's Aug 2026 rig. This is the exact JSON
/// the Node reference engine generates, embedded for parity by construction.
pub fn default_project() -> Project {
    serde_json::from_str(include_str!("default_project.json"))
        .expect("embedded default project must parse")
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_project_parses() {
        let p = super::default_project();
        assert_eq!(p.version, 1);
        assert_eq!(p.fixtures.len(), 5);
        assert_eq!(p.layers.len(), 4);
    }
}
