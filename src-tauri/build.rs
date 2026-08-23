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
    // Rebuild when the verifying key changes, so switching keys cannot leave a
    // stale constant baked into an otherwise-fresh binary.
    println!("cargo:rerun-if-env-changed=LIGHT_LICENCE_PUBLIC_KEY");
    tauri_build::build()
}
