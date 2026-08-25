fn main() {
    // The build's own date, compiled in. `maintUntil` in a licence means "a
    // build released at or before this keeps working forever", so this must be
    // the moment the binary was produced — never a file mtime, which a copy or
    // a re-download silently rewrites into the future.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=LIGHT_BUILD_DATE={stamp}");

    // ONE source of truth for the version, and it is tauri.conf.json because
    // that is the one the bundle actually carries — it becomes
    // CFBundleShortVersionString, which is what the dmg is named after and what
    // an update compares against.
    //
    // src-tauri/Cargo.toml says 0.1.0 and always has. Nothing read it until
    // share.rs told GDTF Share we were "LIGHT/0.1.0", and an updater comparing
    // CARGO_PKG_VERSION would have offered every user every release forever.
    let conf = std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json");
    let version = serde_json::from_str::<serde_json::Value>(&conf)
        .ok()
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(str::to_owned))
        .expect("tauri.conf.json has no version");
    println!("cargo:rustc-env=LIGHT_VERSION={version}");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    // Rebuild when the verifying key changes, so switching keys cannot leave a
    // stale constant baked into an otherwise-fresh binary.
    println!("cargo:rerun-if-env-changed=LIGHT_LICENCE_PUBLIC_KEY");
    tauri_build::build()
}
