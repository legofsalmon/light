use std::fs;
use std::path::PathBuf;

use crate::types::Project;

const BACKUPS: u32 = 5;

/// Project directory: env override → repo-local ./projects (dev) →
/// ~/Library/Application Support/LIGHT/projects (bundled app).
pub fn project_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LIGHT_PROJECT_DIR") {
        return PathBuf::from(dir);
    }
    let local = PathBuf::from("projects");
    if local.exists() || PathBuf::from("package.json").exists() {
        return local;
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("LIGHT")
        .join("projects")
}

pub fn project_path(dir: &PathBuf) -> PathBuf {
    dir.join("default.project.json")
}

pub fn load_project(dir: &PathBuf) -> Option<Project> {
    let raw = fs::read_to_string(project_path(dir)).ok()?;
    match serde_json::from_str::<Project>(&raw) {
        Ok(p) if p.version == 1 => Some(p),
        Ok(_) => {
            eprintln!("[persist] unrecognised project version");
            None
        }
        Err(e) => {
            eprintln!("[persist] failed to parse project: {e}");
            None
        }
    }
}

fn rotate_backups(dir: &PathBuf) {
    let file = project_path(dir);
    for i in (1..BACKUPS).rev() {
        let from = file.with_extension(format!("json.bak{i}"));
        let to = file.with_extension(format!("json.bak{}", i + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
    if file.exists() {
        let _ = fs::copy(&file, file.with_extension("json.bak1"));
    }
}

pub fn save_project(dir: &PathBuf, p: &Project) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    rotate_backups(dir);
    let file = project_path(dir);
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(p)?)?;
    fs::rename(&tmp, &file)?;
    Ok(file)
}
