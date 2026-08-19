//! GDTF Share — fetching a fixture definition the show is missing.
//!
//! This lives in the app shell, deliberately, and not in `light-core`. The crate
//! that drives DMX has no HTTP client and no TLS stack, and adding one so a
//! prep-room convenience could share a module would be the wrong trade: a bug in
//! a web client must never be able to reach the tick loop. The cost of that
//! choice is that this feature exists only in the packaged app — the browser UI
//! and the LAN tablet do not get it, which is right for something you do before
//! doors rather than during a show.
//!
//! What the API actually is, measured rather than assumed (see
//! `docs/investigation-gdtf-share.md`): three PHP endpoints, a per-user account
//! that is mandatory, a `PHPSESSID` cookie with a two-hour idle timeout and no
//! refresh, no server-side search, no pagination, no delta sync, and no ETag or
//! Last-Modified. `getList.php` returns the WHOLE catalogue — 6.4 MB and 12,436
//! entries on a live call — as `Content-Type: text/html` that is really JSON.
//! So: parse on status, never on content type; fetch only when asked; and cache.

use std::path::PathBuf;
use std::sync::Mutex;

const BASE: &str = "https://gdtf-share.com/apis/public";
/// Keychain service name. The account is the Share username.
const KEYCHAIN_SERVICE: &str = "ie.letissier.light.gdtf-share";

/// One live session. `reqwest`'s cookie jar holds the PHPSESSID; there is no
/// token and no locally-checkable expiry, so the only way to discover that the
/// two hours elapsed is to get a 401 back and log in again.
pub struct ShareSession {
    client: Option<reqwest::Client>,
    user: Mutex<Option<String>>,
}

impl ShareSession {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .cookie_store(true)
            .user_agent(concat!("LIGHT/", env!("CARGO_PKG_VERSION")))
            // a 6.4 MB catalogue on a venue connection needs room, but not forever
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("cannot start an HTTP client: {e}"))?;
        Ok(ShareSession { client: Some(client), user: Mutex::new(None) })
    }

    /// A session that cannot reach the network. Used when the HTTP client
    /// fails to build: the console must still open, because none of this is
    /// load-bearing for running a show.
    pub fn disabled() -> Self {
        ShareSession { client: None, user: Mutex::new(None) }
    }

    fn client(&self) -> Result<&reqwest::Client, String> {
        self.client.as_ref().ok_or_else(|| "GDTF Share is unavailable in this build".to_string())
    }

    pub fn user(&self) -> Option<String> {
        self.user.lock().ok().and_then(|u| u.clone())
    }

    /// POST login.php. On success the cookie jar carries the session.
    pub async fn login(&self, user: &str, password: &str) -> Result<(), String> {
        let resp = self
            .client()?
            .post(format!("{BASE}/login.php"))
            .form(&[("user", user), ("password", password)])
            .send()
            .await
            .map_err(|e| format!("cannot reach GDTF Share: {e}"))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // The error body is JSON served as text/html, so decide on status first
        // and only then look at the payload.
        if !status.is_success() {
            return Err(share_error(&body).unwrap_or_else(|| format!("sign-in failed ({status})")));
        }
        if let Some(msg) = share_error(&body) {
            return Err(msg);
        }
        if let Ok(mut slot) = self.user.lock() {
            *slot = Some(user.to_string());
        }
        Ok(())
    }

    /// GET getList.php — the entire catalogue, every time. There is no search
    /// and no incremental fetch, so this is expensive and must stay manual.
    pub async fn list(&self) -> Result<String, String> {
        let resp = self
            .client()?
            .get(format!("{BASE}/getList.php"))
            .send()
            .await
            .map_err(|e| format!("cannot reach GDTF Share: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("truncated response: {e}"))?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("session expired — sign in to GDTF Share again".into());
        }
        if !status.is_success() {
            return Err(share_error(&body).unwrap_or_else(|| format!("catalogue failed ({status})")));
        }
        Ok(body)
    }

    /// GET downloadFile.php?rid=N — the .gdtf itself.
    ///
    /// No checksum is published and no Content-Length is guaranteed, so the
    /// caller validates by parsing: a truncated zip fails to open, which is a
    /// better integrity check than a header we are not given.
    pub async fn download(&self, rid: u64) -> Result<Vec<u8>, String> {
        let resp = self
            .client()?
            // rid is a u64, so there is nothing here to escape and no need to
            // pull reqwest's query feature for it
            .get(format!("{BASE}/downloadFile.php?rid={rid}"))
            .send()
            .await
            .map_err(|e| format!("cannot reach GDTF Share: {e}"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("session expired — sign in to GDTF Share again".into());
        }
        let bytes = resp.bytes().await.map_err(|e| format!("download interrupted: {e}"))?;
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes);
            return Err(share_error(&body).unwrap_or_else(|| format!("download failed ({status})")));
        }
        if bytes.len() < 4 || &bytes[..2] != b"PK" {
            return Err("that download is not a .gdtf archive".into());
        }
        Ok(bytes.to_vec())
    }
}

/// The API reports failure as `{"result":false,"error":"..."}` with a 200 as
/// readily as with a 401, so every response gets checked for it.
fn share_error(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v.get("result").and_then(|r| r.as_bool()) == Some(false) {
        return Some(
            v.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("GDTF Share refused the request")
                .to_string(),
        );
    }
    None
}

// ---------------------------------------------------------------------------
// "remember me"
//
// The Keychain, and nothing else. Not the project file — `shared/types.ts`
// broadcasts the whole Project to every connected client, so a password stored
// there would be handed to a tablet on the venue WiFi.

pub fn remember_password(user: &str, password: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, user)
        .and_then(|e| e.set_password(password))
        .map_err(|e| format!("cannot save to the Keychain: {e}"))
}

pub fn recall(user: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, user).ok()?.get_password().ok()
}

pub fn forget(user: &str) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, user).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("cannot clear the Keychain: {e}")),
    }
}

// ---------------------------------------------------------------------------
// catalogue cache
//
// 6.4 MB per refresh with no delta sync, so it is fetched on an explicit action
// and never at startup. Stored beside the fixture library.

pub fn cache_path(fixture_dir: &PathBuf) -> PathBuf {
    fixture_dir.join("share-catalogue.json")
}

pub fn read_cache(fixture_dir: &PathBuf) -> Option<String> {
    std::fs::read_to_string(cache_path(fixture_dir)).ok()
}

/// Write the catalogue only if it looks like a catalogue.
///
/// In October 2025 the live API served a success-shaped EMPTY list for a day. A
/// cache that trusts that would wipe the operator's shortlist on a refresh, so
/// an empty or collapsed list is refused and the previous cache stands.
pub fn write_cache(fixture_dir: &PathBuf, body: &str) -> Result<usize, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("catalogue is not JSON: {e}"))?;
    let n = v.get("list").and_then(|l| l.as_array()).map_or(0, |a| a.len());
    if v.get("result").and_then(|r| r.as_bool()) != Some(true) || n == 0 {
        return Err("GDTF Share returned an empty catalogue — keeping the last good one".into());
    }
    let previous = read_cache(fixture_dir)
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("list").and_then(|l| l.as_array()).map(|a| a.len()))
        .unwrap_or(0);
    if previous > 0 && n < previous * 3 / 4 {
        return Err(format!(
            "GDTF Share returned {n} fixtures, down from {previous} — keeping the last good one"
        ));
    }
    std::fs::create_dir_all(fixture_dir).map_err(|e| format!("cannot create {fixture_dir:?}: {e}"))?;
    std::fs::write(cache_path(fixture_dir), body).map_err(|e| format!("cannot write cache: {e}"))?;
    Ok(n)
}

/// Base64 for the trip to the UI and straight back into `importGdtf`.
///
/// Hand-rolled rather than adding a crate: light-core already carries its own
/// decoder for the same wire format, this is the matching half, and a 40-line
/// encoder is a smaller liability than another dependency in a signed bundle.
pub fn base64_encode(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_through_the_engines_decoder() {
        // The real contract: these bytes go to the UI and come straight back
        // into importGdtf, where light-core decodes them. Both halves are hand
        // written, in different crates — a known-answer test on this side would
        // prove nothing about the other, so decode with the actual decoder.
        assert_eq!(base64_encode(b"any carnal pleasure."), "YW55IGNhcm5hbCBwbGVhc3VyZS4=");

        // every length class, so padding is exercised in all three shapes
        for n in 0..64usize {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            let round = light_core::state::base64_decode(&base64_encode(&bytes))
                .unwrap_or_else(|e| panic!("len {n} failed to decode: {e}"));
            assert_eq!(round, bytes, "round trip broke at length {n}");
        }

        // and a payload shaped like the thing this actually carries
        let zipish: Vec<u8> = b"PK\x03\x04"
            .iter()
            .copied()
            .chain((0..5000u32).map(|i| (i % 251) as u8))
            .collect();
        assert_eq!(
            light_core::state::base64_decode(&base64_encode(&zipish)).unwrap(),
            zipish
        );
    }

    #[test]
    fn errors_are_read_from_the_body_not_the_status() {
        // the API returns this shape with a 200 as readily as with a 401
        assert_eq!(
            share_error(r#"{"result":false,"error":"Unauthorized."}"#),
            Some("Unauthorized.".to_string())
        );
        assert_eq!(share_error(r#"{"result":true,"list":[]}"#), None);
        assert_eq!(share_error("<html>nope</html>"), None);
    }

    #[test]
    fn an_empty_catalogue_never_replaces_a_good_one() {
        let dir = std::env::temp_dir().join(format!("light-share-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let good = r#"{"result":true,"list":[{"rid":1},{"rid":2},{"rid":3},{"rid":4}]}"#;
        assert_eq!(write_cache(&dir, good), Ok(4));

        // the October 2025 failure mode: success-shaped, empty
        assert!(write_cache(&dir, r#"{"result":true,"list":[]}"#).is_err());
        // and a collapse, which is the same hazard wearing a hat
        assert!(write_cache(&dir, r#"{"result":true,"list":[{"rid":1}]}"#).is_err());
        // the good one is still there
        assert!(read_cache(&dir).unwrap().contains("\"rid\":4"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — the only surface the UI sees.
//
// Everything above is deliberately free of Tauri types so it can be unit tested
// without an app. These are the thin wrappers that give the webview access.

use tauri::State;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    /// signed-in user for this run, if any
    pub user: Option<String>,
    /// how many fixtures the cached catalogue holds (0 = never fetched)
    pub cached: usize,
    /// unix seconds the cache was written, if it exists
    pub cached_at: Option<u64>,
}

fn fixture_dir() -> PathBuf {
    light_core::persist::fixture_dir()
}

#[tauri::command]
pub fn share_status(session: State<'_, ShareSession>) -> ShareStatus {
    let dir = fixture_dir();
    let cached = read_cache(&dir)
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("list").and_then(|l| l.as_array()).map(|a| a.len()))
        .unwrap_or(0);
    let cached_at = std::fs::metadata(cache_path(&dir))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    ShareStatus { user: session.user(), cached, cached_at }
}

#[tauri::command]
pub async fn share_login(
    session: State<'_, ShareSession>,
    user: String,
    password: String,
    remember: bool,
) -> Result<(), String> {
    session.login(&user, &password).await?;
    // only after the credentials are known to work — storing a wrong password
    // that then fails silently every launch is worse than not storing one
    if remember {
        remember_user(&user)?;
        remember_password(&user, &password)?;
    }
    Ok(())
}

/// Sign in with what the Keychain holds, so "remember me" survives a restart.
#[tauri::command]
pub async fn share_login_saved(session: State<'_, ShareSession>) -> Result<String, String> {
    let user = saved_user().ok_or("no saved GDTF Share sign-in")?;
    let password = recall(&user).ok_or("the saved sign-in is no longer in the Keychain")?;
    session.login(&user, &password).await?;
    Ok(user)
}

#[tauri::command]
pub fn share_forget() -> Result<(), String> {
    if let Some(user) = saved_user() {
        forget(&user)?;
    }
    let _ = std::fs::remove_file(fixture_dir().join("share-user"));
    Ok(())
}

#[tauri::command]
pub fn share_saved_user() -> Option<String> {
    saved_user()
}

/// Pull the whole catalogue. Explicit action only — 6.4 MB, no delta sync.
#[tauri::command]
pub async fn share_refresh(session: State<'_, ShareSession>) -> Result<usize, String> {
    let body = session.list().await?;
    write_cache(&fixture_dir(), &body)
}

#[tauri::command]
pub fn share_catalogue() -> Option<String> {
    read_cache(&fixture_dir())
}

/// Download one fixture and hand it back base64, ready for `importGdtf`.
///
/// It is also written into the fixture library, so the same fixture is not
/// pulled twice and so the library is browsable outside the app.
#[tauri::command]
pub async fn share_download(
    session: State<'_, ShareSession>,
    rid: u64,
    name: String,
) -> Result<String, String> {
    let bytes = session.download(rid).await?;
    let dir = fixture_dir();
    if std::fs::create_dir_all(&dir).is_ok() {
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let _ = std::fs::write(dir.join(format!("{safe}-{rid}.gdtf")), &bytes);
    }
    Ok(base64_encode(&bytes))
}

/// The username sits beside the fixture library; only the PASSWORD is a secret.
/// Keeping it out of the Keychain means "which account is this?" can be
/// answered without prompting for Keychain access on every launch.
fn user_path() -> PathBuf {
    fixture_dir().join("share-user")
}

fn saved_user() -> Option<String> {
    let s = std::fs::read_to_string(user_path()).ok()?;
    let s = s.trim();
    if s.is_empty() { None } else { Some(s.to_string()) }
}

fn remember_user(user: &str) -> Result<(), String> {
    let dir = fixture_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {dir:?}: {e}"))?;
    std::fs::write(user_path(), user).map_err(|e| format!("cannot save the username: {e}"))
}
