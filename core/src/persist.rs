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
    file_for(dir, &current_slug(dir))
}

pub fn file_for(dir: &PathBuf, slug: &str) -> PathBuf {
    dir.join(format!("{slug}.project.json"))
}

/// Active project slug from the `.current` pointer file; 'default' matches
/// the pre-multi-project layout so existing installs keep working.
pub fn current_slug(dir: &PathBuf) -> String {
    let s = fs::read_to_string(dir.join(".current")).unwrap_or_default();
    let s = s.trim();
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        s.to_string()
    } else {
        "default".to_string()
    }
}

pub fn set_current_slug(dir: &PathBuf, slug: &str) {
    let _ = fs::create_dir_all(dir);
    if let Err(e) = fs::write(dir.join(".current"), slug) {
        eprintln!("[persist] cannot write .current: {e}");
    }
}

pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = true; // suppress leading dashes
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "untitled".into() } else { out }
}

pub fn unique_slug(dir: &PathBuf, name: &str) -> String {
    let base = slugify(name);
    if !file_for(dir, &base).exists() {
        return base;
    }
    for i in 2..100 {
        let cand = format!("{base}-{i}");
        if !file_for(dir, &cand).exists() {
            return cand;
        }
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{base}-{ts}")
}

pub fn list_projects(dir: &PathBuf) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let fname = e.file_name().to_string_lossy().to_string();
        let Some(slug) = fname.strip_suffix(".project.json") else { continue };
        let name = fs::read_to_string(e.path())
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
            .unwrap_or_else(|| format!("{slug} (unreadable)"));
        out.push((slug.to_string(), name));
    }
    out.sort();
    out
}

pub fn load_slug(dir: &PathBuf, slug: &str) -> Option<Project> {
    let raw = fs::read_to_string(file_for(dir, slug)).ok()?;
    match serde_json::from_str::<Project>(&raw) {
        Ok(p) if p.version == 1 => Some(p),
        _ => None,
    }
}

pub fn save_slug_now(dir: &PathBuf, slug: &str, p: &Project) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let file = file_for(dir, slug);
    // overwriting a slug other than the current one preserves the old file
    // aside — save-as onto an existing show must never destroy it outright
    if slug != current_slug(dir) && file.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = fs::copy(&file, dir.join(format!("{slug}.project.json.replaced-{ts}")));
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(p)?)?;
    fs::rename(&tmp, &file)?;
    Ok(())
}

/// Rotate backups and save under an explicit slug — the autosave worker
/// passes the slug captured on the tick thread, so a project switch during
/// the write can never redirect it.
pub fn save_project_slug(dir: &PathBuf, slug: &str, p: &Project) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let file = file_for(dir, slug);
    for i in (1..BACKUPS).rev() {
        let from = dir.join(format!("{slug}.project.json.bak{i}"));
        let to = dir.join(format!("{slug}.project.json.bak{}", i + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
    if file.exists() {
        let _ = fs::copy(&file, dir.join(format!("{slug}.project.json.bak1")));
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(p)?)?;
    fs::rename(&tmp, &file)?;
    Ok(file)
}

fn try_load(path: &std::path::Path) -> Option<Project> {
    let raw = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Project>(&raw) {
        Ok(p) if p.version == 1 => Some(p),
        _ => None,
    }
}

/// Load the current project, falling back through its rotating backups —
/// a missing or corrupt main file must never cost the show (mirrors the
/// Node reference, including the fall-back to the 'default' slug when a
/// dead .current pointer has neither file nor backups).
pub fn load_project(dir: &PathBuf) -> Option<Project> {
    let slug = current_slug(dir);
    let file = file_for(dir, &slug);
    if let Some(p) = try_load(&file) {
        return Some(p);
    }
    if file.exists() {
        eprintln!("[persist] project file is corrupt — trying backups");
        let _ = fs::rename(
            &file,
            dir.join(format!(
                "{slug}.project.json.corrupt-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            )),
        );
    }
    for i in 1..=BACKUPS {
        let bak = dir.join(format!("{slug}.project.json.bak{i}"));
        if let Some(p) = try_load(&bak) {
            eprintln!("[persist] recovered {slug} from .bak{i}");
            let _ = save_slug_now(dir, &slug, &p);
            return Some(p);
        }
    }
    if slug != "default" {
        eprintln!("[persist] project \"{slug}\" has no file or backups — falling back to default");
        set_current_slug(dir, "default");
        return load_project(dir);
    }
    None
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
