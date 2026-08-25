//! Replacing LIGHT with a newer LIGHT.
//!
//! The bundle cannot be modified in place. Adding a file to a signed bundle
//! breaks its seal, and a broken seal is *worse* than no signature — Gatekeeper
//! rejects outright rather than offering the Open Anyway path
//! (`docs/distribution.md`). There is no merge, no rsync, no "update the changed
//! files". The only safe operation is a whole-bundle swap performed by a process
//! that is not inside the bundle, after this one has quit and flushed.
//!
//! So the shape is: download → unpack → verify → write a script → arm → quit
//! normally → the script swaps and relaunches. Nothing is replaced until LIGHT
//! is already gone, and the project is already on disk.
//!
//! The trust anchor is Apple's, not a key of ours. `verify` insists the download
//! is signed by the same Developer ID team as the running copy AND that Apple
//! notarised it, which is a stronger statement than "we signed it" and needs no
//! second secret that could be lost.

use crate::update::Release;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Refuse a body larger than this. The real one is ~26 MB.
const MAX_BYTES: u64 = 300 * 1024 * 1024;
/// A blackout between songs must not read as "the room is empty".
const LIVE_GRACE_MS: u64 = 30_000;

// ------------------------------------------------------------- Where we are

/// The `.app` this process is running from, if it is running from one at all.
pub fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // …/LIGHT.app/Contents/MacOS/light-app
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().is_some_and(|e| e == "app") && bundle.join("Contents/Info.plist").is_file())
        .then(|| bundle.to_path_buf())
}

/// The Developer ID team of a bundle, read off `codesign -dv` — which prints to
/// **stderr**, not stdout.
fn team_id(bundle: &Path) -> Option<String> {
    let out = Command::new("/usr/bin/codesign").args(["-dv"]).arg(bundle).output().ok()?;
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .find_map(|l| l.strip_prefix("TeamIdentifier=").map(str::to_owned))
        .filter(|t| t != "not set")
}

fn plist_string(bundle: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Why this copy cannot update itself, or None if it can.
///
/// Memoised: it forks `codesign`, and a panel that polls would otherwise fork
/// once a render. Decided once per launch because none of these can change
/// without the app being moved, which means relaunching anyway.
pub fn blocker() -> Option<&'static str> {
    static BLOCKER: OnceLock<Option<&'static str>> = OnceLock::new();
    *BLOCKER.get_or_init(|| {
        if !cfg!(target_os = "macos") {
            return Some("in-app updates are macOS only");
        }
        let Some(bundle) = running_bundle() else {
            return Some("this copy is not running from an app bundle — update by downloading");
        };
        if bundle.to_string_lossy().contains("/AppTranslocation/") {
            // Gatekeeper runs quarantined apps from a read-only shadow copy.
            return Some("move LIGHT to your Applications folder first, then reopen it");
        }
        if team_id(&bundle).is_none() {
            return Some("this build is not Developer ID signed — update by downloading");
        }
        let Some(parent) = bundle.parent() else {
            return Some("cannot see the folder LIGHT is in");
        };
        // The swap is a rename in this directory, so it is the one that has to
        // be writable — not the bundle.
        if std::fs::metadata(parent).map(|m| m.permissions().readonly()).unwrap_or(true) {
            return Some("the folder LIGHT is in is not writable — update by downloading");
        }
        None
    })
}

// ------------------------------------------------------------------ Staging

fn staging() -> PathBuf {
    // $TMPDIR on macOS is per-user and mode 700; /tmp is world-writable and the
    // verify→swap window would be another account's to interfere with.
    std::env::temp_dir().join("light-update")
}

fn script_path() -> PathBuf {
    // Deliberately NOT inside staging(): the script deletes that directory, and
    // a script deleting the directory it is being read from finishes or does not
    // depending on how the shell buffered it.
    std::env::temp_dir().join("light-update-swap.sh")
}

/// Single-quote for `sh`, the only quoting that needs no escape table: inside
/// single quotes every byte is literal, so the one case is the quote itself.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------- Progress

#[derive(Default)]
pub struct Install {
    got: AtomicU64,
    total: AtomicU64,
    /// Set once the download is unpacked and verified: what will be swapped in.
    staged: Mutex<Option<(PathBuf, String)>>,
    stage: Mutex<String>,
    /// Armed by `update_install`; read in `ExitRequested` after the flush.
    armed: Mutex<Option<PathBuf>>,
}

impl Install {
    pub fn new() -> Self {
        Install::default()
    }
    fn set_stage(&self, s: &str) {
        if let Ok(mut slot) = self.stage.lock() {
            *slot = s.to_string();
        }
    }
    pub fn armed_script(&self) -> Option<PathBuf> {
        self.armed.lock().ok().and_then(|s| s.clone())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: String,
    pub got: u64,
    pub total: u64,
    pub staged_version: Option<String>,
    pub blocker: Option<&'static str>,
    /// Why installing right now would be a bad idea, if it would.
    pub refusal: Option<String>,
}

/// The one question that outranks everything else here.
///
/// Refuse, never queue. "It will install when you stop" is a promise to do
/// something disruptive at a moment nobody chose.
pub fn refusal() -> Option<String> {
    if light_core::engine::rig_lit_within(LIVE_GRACE_MS) {
        return Some(
            "the rig is lit — installing stops the output and reopens LIGHT. Black out first."
                .into(),
        );
    }
    let clients = light_core::engine::client_count();
    if clients > 1 {
        return Some(format!(
            "{clients} devices are connected — someone may be driving the show from a tablet"
        ));
    }
    None
}

// ------------------------------------------------------------ The download

async fn download(install: &Install, release: &Release, to: &Path) -> Result<(), String> {
    install.set_stage("downloading");
    install.got.store(0, Ordering::Relaxed);
    install.total.store(release.size, Ordering::Relaxed);

    let client = reqwest::Client::builder()
        .user_agent(concat!("LIGHT/", env!("LIGHT_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .get(&release.asset_url)
        .send()
        .await
        .map_err(|e| format!("could not start the download: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("the download returned {}", res.status()));
    }
    if let Some(len) = res.content_length() {
        if len > MAX_BYTES {
            return Err("that download is implausibly large — refusing it".into());
        }
        install.total.store(len, Ordering::Relaxed);
    }

    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    // chunk() rather than a stream, so no futures-util in the tree for this.
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("the download stopped: {e}"))? {
        written += chunk.len() as u64;
        if written > MAX_BYTES {
            return Err("that download is implausibly large — refusing it".into());
        }
        use std::io::Write;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        install.got.store(written, Ordering::Relaxed);
    }
    drop(file);

    // vizz never checks this and lets a truncated body reach ditto, which then
    // fails with something about the archive rather than about the network.
    if release.size > 0 && written != release.size {
        return Err(format!(
            "the download stopped early — {written} bytes of {}",
            release.size
        ));
    }
    Ok(())
}

fn unpack(install: &Install, zip: &Path, into: &Path) -> Result<PathBuf, String> {
    install.set_stage("unpacking");
    // ditto, never a Rust zip crate: the release is packed with `ditto -c -k
    // --keepParent` and the code signature covers extended attributes and
    // symlinks that a naive extractor silently drops — which would break the
    // seal on a bundle that was perfectly good.
    let out = Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(zip)
        .arg(into)
        .output()
        .map_err(|e| format!("could not run ditto: {e}"))?;
    if !out.status.success() {
        return Err(format!("could not unpack: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    std::fs::read_dir(into)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "app"))
        .ok_or_else(|| "the download contained no app".into())
}

/// The security boundary. Everything before this is bytes off the network.
fn verify(install: &Install, bundle: &Path, release: &Release) -> Result<(), String> {
    install.set_stage("verifying");

    let codesign = |args: &[&str], path: &Path, what: &str| -> Result<(), String> {
        let out = Command::new("/usr/bin/codesign")
            .args(args)
            .arg(path)
            .output()
            .map_err(|e| format!("could not run codesign: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("{what}: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    };

    // 1. the seal is intact. No --deep: Apple deprecates it for verification,
    //    and the nested binary is checked explicitly below instead.
    codesign(&["--verify", "--strict"], bundle, "the download is not correctly signed")?;

    // 2. the grafted binary specifically. It is the file whose presence broke
    //    the seal in the first place, so it is the one worth naming.
    let previz = bundle.join("Contents/MacOS/light-previz");
    if !previz.is_file() {
        return Err("the download has no previz binary — it is not a complete LIGHT".into());
    }
    codesign(&["--verify", "--strict"], &previz, "the previz binary is not correctly signed")?;

    // 3. same team as this copy, anchored to Apple.
    //
    //    The `anchor apple generic` clause is load-bearing and is what vizz's
    //    plain --verify is missing: TeamIdentifier comes from the certificate's
    //    OU, which a self-signed certificate can assert freely. Without the
    //    anchor, "same team" is a claim the attacker gets to make.
    let running = running_bundle().ok_or("no running bundle to compare against")?;
    let ours = team_id(&running).ok_or("the running copy is not Developer ID signed")?;
    let req = format!(
        "=anchor apple generic and certificate leaf[subject.OU] = \"{ours}\""
    );
    codesign(
        &["--verify", "--strict", "-R", &req],
        bundle,
        "the download is not signed by the same developer as this copy",
    )?;

    // 4. Apple notarised THIS build, and the ticket travelled inside the file.
    //    Works offline, and unlike spctl it is not disabled by
    //    `spctl --master-disable` — which is set on at least one machine here.
    let out = Command::new("/usr/bin/xcrun")
        .args(["stapler", "validate"])
        .arg(bundle)
        .output()
        .map_err(|e| format!("could not run stapler: {e}"))?;
    if !out.status.success() {
        return Err("the download is not notarised by Apple — refusing it".into());
    }

    // 5. same identity, or the swap silently costs the operator their Keychain
    //    items and their Local Network permission (and with it Art-Net).
    let want = plist_string(&running, "CFBundleIdentifier")
        .ok_or("cannot read this copy's bundle identifier")?;
    let got = plist_string(bundle, "CFBundleIdentifier")
        .ok_or("the download has no bundle identifier")?;
    if got != want {
        return Err(format!("the download identifies as {got}, not {want}"));
    }

    // 6. it is the version that was offered.
    let v = plist_string(bundle, "CFBundleShortVersionString")
        .ok_or("the download has no readable version")?;
    if v != release.version.raw.trim_start_matches('v') {
        return Err(format!("the download is version {v}, but {} was offered", release.version.raw));
    }
    Ok(())
}

/// Download, unpack and verify. Nothing is replaced by this — it only stages.
pub async fn stage(install: &Install, release: &Release) -> Result<(), String> {
    if let Some(b) = blocker() {
        return Err(b.to_string());
    }
    let dir = staging();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // A hardcoded name: the asset name is attacker-influenced data and never
    // becomes a path component.
    let zip = dir.join("LIGHT.zip");
    download(install, release, &zip).await?;
    let bundle = unpack(install, &zip, &dir)?;
    verify(install, &bundle, release)?;
    let _ = std::fs::remove_file(&zip);

    install.set_stage("ready");
    if let Ok(mut slot) = install.staged.lock() {
        *slot = Some((bundle, release.version.raw.clone()));
    }
    Ok(())
}

// ---------------------------------------------------------------- The swap

/// Write the script that does the replacing. It is not run here — `main.rs`
/// spawns it from `ExitRequested`, after the engine has flushed the project.
pub fn write_swap_script(staged: &Path, target: &Path, port: u16) -> Result<PathBuf, String> {
    write_swap_script_as(staged, target, port, std::process::id(), &script_path())
}

/// The body, with the pid and the destination injectable so the script can be
/// tested for real rather than eyeballed. It is the only code here that deletes
/// anything, so it is the piece most worth running in a test.
fn write_swap_script_as(
    staged: &Path,
    target: &Path,
    port: u16,
    pid: u32,
    path: &Path,
) -> Result<PathBuf, String> {
    let same_volume = same_device(staged.parent().unwrap_or(staged), target.parent().unwrap_or(target));
    if !same_volume {
        // mv degrades to copy-then-unlink across devices, which is neither
        // atomic nor safe to interrupt. Rather than ship an untested path,
        // refuse and let the operator drag it over.
        return Err(
            "LIGHT is on a different volume from the temporary folder — install it by downloading"
                .into(),
        );
    }
    let script = format!(
        r#"#!/bin/sh
# Written by LIGHT to replace itself. Runs detached, after LIGHT has quit.
set -u
PID={pid}
NEW={new}
TARGET={target}
BAK={bak}
PORT={port}

# 1. wait for LIGHT to actually be gone (60 s cap)
i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done

# 2. and for its port to be released. Without this the relaunched copy finds
#    :$PORT still held and pops a blocking dialog at the worst possible moment.
i=0
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done

# 3. move the old one aside, then move the new one in. The window between these
#    two renames is the only moment there is no LIGHT on this machine, and both
#    are same-volume renames.
rm -rf "$BAK"
mv "$TARGET" "$BAK" || exit 1
if ! mv "$NEW" "$TARGET"; then
  mv "$BAK" "$TARGET"
  exit 1
fi
rm -rf "$BAK"

# 4. only now, and only if one is present: it was verified before it got here.
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null

open "$TARGET"
rm -rf {staging}
rm -f "$0"
"#,
        pid = pid,
        new = shell_quote(&staged.to_string_lossy()),
        target = shell_quote(&target.to_string_lossy()),
        bak = shell_quote(&format!("{}.old", target.to_string_lossy())),
        staging = shell_quote(&staging().to_string_lossy()),
        port = port,
    );
    std::fs::write(path, script).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(path.to_path_buf())
}

fn same_device(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Stage → script → armed. The caller then asks the app to exit normally.
pub fn arm(install: &Install, port: u16) -> Result<PathBuf, String> {
    if let Some(why) = refusal() {
        return Err(why);
    }
    let (staged, _v) = install
        .staged
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or("nothing has been downloaded yet")?;
    let target = running_bundle().ok_or("this copy is not running from an app bundle")?;
    let script = write_swap_script(&staged, &target, port)?;
    if let Ok(mut slot) = install.armed.lock() {
        *slot = Some(script.clone());
    }
    install.set_stage("armed");
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This is quoting for a script that runs `rm -rf`. The property is the
    /// whole point: whatever goes in comes back out as exactly one argument.
    #[test]
    fn shell_quote_survives_everything_a_path_can_contain() {
        let nasty = [
            "a'b",
            "a\"b",
            "$(whoami)",
            "`id`",
            "a b; rm -rf /",
            "'",
            "''",
            "/Applications/LIGHT.app",
            "/Users/x/My Apps/LIGHT.app",
            "a\nb",
            "$HOME",
            "\\",
        ];
        for s in nasty {
            let quoted = shell_quote(s);
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("printf %s {quoted}"))
                .output()
                .expect("sh");
            assert!(out.status.success(), "sh rejected {quoted}");
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                s,
                "{s:?} did not survive quoting as {quoted}"
            );
        }
    }

    /// Forking codesign once a render would be a real cost, so the answer is
    /// memoised. If that ever regresses it should regress loudly.
    #[test]
    fn the_blocker_is_decided_once() {
        let first = blocker();
        for _ in 0..500 {
            assert_eq!(blocker(), first, "blocker() changed its mind");
        }
    }

    /// Under `cargo test` we are not in a bundle, so the blocker must say so
    /// rather than letting a test run try to replace something.
    #[test]
    fn a_non_bundle_copy_refuses_to_update_itself() {
        assert!(running_bundle().is_none(), "the test binary is not in a .app");
        assert!(blocker().is_some(), "a loose binary must not offer to replace itself");
    }

    /// The staging directory and the script must not be nested, or the script
    /// deletes the ground it is standing on.
    #[test]
    fn the_script_lives_above_the_directory_it_deletes() {
        assert!(!script_path().starts_with(staging()));
    }

    /// A refusal is a sentence an operator can act on, not a boolean.
    #[test]
    fn a_refusal_names_what_to_do() {
        if let Some(r) = refusal() {
            assert!(r.len() > 20, "refusal too terse to act on: {r}");
        }
    }

    // ---- the swap script, run for real ----
    //
    // This is the only code in LIGHT that deletes an application, so it is run
    // rather than reasoned about. `open`, `lsof` and `xattr` are stubbed on PATH
    // so the script's own logic is what is under test and nothing launches.

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("light-swaptest-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("sandbox");
        dir
    }

    fn stub_path(dir: &Path) -> PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        for (name, body) in [
            ("open", "#!/bin/sh\necho \"$1\" >> \"$(dirname \"$0\")/../opened\"\n"),
            // non-zero = nothing is listening, so the wait loop falls straight through
            ("lsof", "#!/bin/sh\nexit 1\n"),
            ("xattr", "#!/bin/sh\nexit 0\n"),
        ] {
            let p = bin.join(name);
            std::fs::write(&p, body).expect("stub");
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        bin
    }

    /// A pid that is definitely gone: spawn something trivial and reap it.
    ///
    /// NOT 0 — `kill(2)` reads 0 as "every process in this process group", so
    /// `kill -0 0` succeeds and the script's wait loop runs its full 60 s cap.
    /// It still completes, which is the loop behaving correctly, but it made
    /// these tests take a minute each.
    fn dead_pid() -> u32 {
        let mut child = Command::new("/usr/bin/true").spawn().expect("spawn");
        let pid = child.id();
        let _ = child.wait();
        pid
    }

    fn run_script(script: &Path, bin: &Path) -> std::process::Output {
        Command::new("/bin/sh")
            .arg(script)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .output()
            .expect("sh")
    }

    /// The happy path, end to end: the new bundle ends up at the target, the
    /// backup is gone, and the app is reopened.
    #[test]
    fn the_swap_replaces_the_bundle_and_reopens_it() {
        let dir = sandbox("happy");
        let bin = stub_path(&dir);
        let target = dir.join("LIGHT.app");
        let staged = dir.join("staged").join("LIGHT.app");
        std::fs::create_dir_all(target.join("Contents")).expect("target");
        std::fs::write(target.join("Contents/marker"), "OLD").expect("old");
        std::fs::create_dir_all(staged.join("Contents")).expect("staged");
        std::fs::write(staged.join("Contents/marker"), "NEW").expect("new");

        let script = dir.join("swap.sh");
        write_swap_script_as(&staged, &target, 9900, dead_pid(), &script).expect("script");
        let out = run_script(&script, &bin);
        assert!(out.status.success(), "script failed: {}", String::from_utf8_lossy(&out.stderr));

        assert_eq!(
            std::fs::read_to_string(target.join("Contents/marker")).expect("target after"),
            "NEW",
            "the new bundle is not in place"
        );
        assert!(!dir.join("LIGHT.app.old").exists(), "the backup was left behind");
        assert!(!staged.exists(), "the staged copy was left behind");
        assert!(!script.exists(), "the script did not remove itself");
        assert!(dir.join("opened").is_file(), "LIGHT was not reopened");
    }

    /// The case that matters most: if moving the new one in fails, the old one
    /// comes back. The alternative is a machine with no LIGHT on it.
    #[test]
    fn a_failed_swap_puts_the_old_bundle_back() {
        let dir = sandbox("rollback");
        let bin = stub_path(&dir);
        let target = dir.join("LIGHT.app");
        std::fs::create_dir_all(target.join("Contents")).expect("target");
        std::fs::write(target.join("Contents/marker"), "OLD").expect("old");
        // staged never existed — the second mv cannot succeed
        let staged = dir.join("staged").join("LIGHT.app");
        std::fs::create_dir_all(dir.join("staged")).expect("staging dir");

        let script = dir.join("swap.sh");
        write_swap_script_as(&staged, &target, 9900, dead_pid(), &script).expect("script");
        let out = run_script(&script, &bin);

        assert!(!out.status.success(), "a swap that could not happen reported success");
        assert_eq!(
            std::fs::read_to_string(target.join("Contents/marker")).expect("target restored"),
            "OLD",
            "the old bundle was not restored — this machine would have no LIGHT on it"
        );
        assert!(!dir.join("opened").exists(), "a failed swap should not reopen anything");
    }

    /// A path with a space and a quote in it must survive into the script.
    #[test]
    fn the_swap_survives_a_hostile_path() {
        let dir = sandbox("quoting");
        let bin = stub_path(&dir);
        let awkward = dir.join("Colm's Apps; rm -rf x");
        std::fs::create_dir_all(&awkward).expect("dir");
        let target = awkward.join("LIGHT.app");
        let staged = dir.join("staged").join("LIGHT.app");
        std::fs::create_dir_all(target.join("Contents")).expect("target");
        std::fs::write(target.join("Contents/marker"), "OLD").expect("old");
        std::fs::create_dir_all(staged.join("Contents")).expect("staged");
        std::fs::write(staged.join("Contents/marker"), "NEW").expect("new");

        let script = dir.join("swap.sh");
        write_swap_script_as(&staged, &target, 9900, dead_pid(), &script).expect("script");
        let out = run_script(&script, &bin);
        assert!(out.status.success(), "script failed: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_to_string(target.join("Contents/marker")).unwrap(), "NEW");
        assert!(awkward.is_dir(), "the awkward directory was destroyed");
    }
}

// ----------------------------------------------------------------- Commands
//
// Kept at the bottom rather than in update.rs so the check (which every copy
// does) and the install (which only a bundled, signed, writable copy can do)
// stay separable — a build that can never install still reports honestly.

use tauri::State;

#[tauri::command]
pub fn update_progress(install: State<'_, Install>) -> InstallProgress {
    InstallProgress {
        stage: install.stage.lock().map(|s| s.clone()).unwrap_or_default(),
        got: install.got.load(Ordering::Relaxed),
        total: install.total.load(Ordering::Relaxed),
        staged_version: install.staged.lock().ok().and_then(|s| s.clone()).map(|(_, v)| v),
        blocker: blocker(),
        refusal: refusal(),
    }
}

#[tauri::command]
pub async fn update_download(
    install: State<'_, Install>,
    updates: State<'_, crate::update::Updates>,
) -> Result<InstallProgress, String> {
    let release = updates.available().ok_or("there is no update to download")?;
    if let Err(e) = stage(&install, &release).await {
        install.set_stage("failed");
        // Never leave a half-unpacked bundle where the next attempt would find
        // it and think it was verified.
        let _ = std::fs::remove_dir_all(staging());
        if let Ok(mut slot) = install.staged.lock() {
            *slot = None;
        }
        return Err(e);
    }
    Ok(update_progress(install))
}

/// Arm the swap and ask the app to quit. The script is spawned from
/// `RunEvent::ExitRequested`, AFTER the engine has flushed the project — never
/// from here, and never through `app.restart()`, which skips the flush and
/// would cost the operator whatever they had not saved.
#[tauri::command]
pub fn update_install(
    app: tauri::AppHandle,
    install: State<'_, Install>,
    port: u16,
) -> Result<(), String> {
    arm(&install, port)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn update_cancel(install: State<'_, Install>) -> InstallProgress {
    let _ = std::fs::remove_dir_all(staging());
    let _ = std::fs::remove_file(script_path());
    if let Ok(mut slot) = install.staged.lock() {
        *slot = None;
    }
    if let Ok(mut slot) = install.armed.lock() {
        *slot = None;
    }
    install.got.store(0, Ordering::Relaxed);
    install.set_stage("");
    update_progress(install)
}
