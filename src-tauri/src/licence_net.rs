//! The I/O half of licensing: machine identity, the Keychain, the four HTTP
//! calls, and the Tauri commands the licence panel drives.
//!
//! Three rules this module exists to keep:
//!
//! 1. **Never on the startup path.** The only thing that happens before the
//!    engine starts is reading a cached token off the Keychain and deciding it
//!    offline. Every network call here is user-initiated or on a background
//!    timer, and a failed one falls back to the cached answer.
//! 2. **The token is not project data.** It lives in the Keychain, beside the
//!    GDTF Share credentials and under the same reasoning: `Project` is
//!    broadcast whole to every connected client, including a LAN tablet.
//! 3. **Nothing here stops a running show.** The only gate is at session start
//!    and it is `main.rs` that applies it, once, before the engine thread.

use crate::licence::{check, Claims, Status, Verdict};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::State;

const BASE: &str = "https://letissier.ie";
const PRODUCT: &str = "light";
const KEYCHAIN_SERVICE: &str = "ie.letissier.light.licence";
const TOKEN_ACCOUNT: &str = "token";
const KEY_ACCOUNT: &str = "key";

/// Stamped at compile time by `build.rs`. It has to be the *build's* date, not
/// a file mtime, because that is what makes `maintUntil` mean "a build released
/// before this keeps working forever" — a copied or re-downloaded file would
/// otherwise silently re-date itself.
const BUILD_DATE: i64 = match i64::from_str_radix(env!("LIGHT_BUILD_DATE"), 10) {
    Ok(v) => v,
    Err(_) => 0,
};

/// The verifying key, baked in at compile time.
///
/// Empty until the LeTissier deployment has a signing key configured — the
/// integration page currently serves `REPLACE_WITH_YOUR_PUBLIC_KEY_HEX` and
/// says so. An empty key verifies nothing, so every token reads `invalid`,
/// which is a banner and never a locked console. Set it at build time:
///
/// ```sh
/// LIGHT_LICENCE_PUBLIC_KEY=<64 hex chars> npm run app:build
/// ```
///
/// It is a *public* key: embedding it is the intended use, and it can only
/// verify, never mint.
const PUBLIC_KEY: &str = match option_env!("LIGHT_LICENCE_PUBLIC_KEY") {
    Some(k) => k,
    None => "",
};

pub fn public_key_configured() -> bool {
    PUBLIC_KEY.len() == 64
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// This machine, as the service names it: sha256 of the platform id, first 32
/// hex characters. Deliberately not a MAC address — those change with docks,
/// VPNs and USB adapters, and a fingerprint that moves burns a seat every time
/// someone plugs into a different desk.
pub fn machine_hash() -> String {
    let raw = platform_id().unwrap_or_default();
    let digest = Sha256::digest(raw.trim().as_bytes());
    hex(&digest)[..32].to_string()
}

#[cfg(target_os = "macos")]
fn platform_id() -> Option<String> {
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('"').nth(3))
        .map(|s| s.to_string())
}

#[cfg(not(target_os = "macos"))]
fn platform_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id").ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------- Keychain

fn store(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| e.to_string())
}

fn load(account: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).ok()?.get_password().ok()
}

fn forget(account: &str) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, account).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ------------------------------------------------------------------ State

pub struct Licence {
    client: Option<reqwest::Client>,
    machine: String,
    last: Mutex<Verdict>,
}

impl Licence {
    pub fn new() -> Self {
        let machine = machine_hash();
        let last = Mutex::new(decide(&machine));
        Licence {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .ok(),
            machine,
            last,
        }
    }

    pub fn verdict(&self) -> Verdict {
        self.last.lock().map(|v| v.clone()).unwrap_or_else(|_| decide(&self.machine))
    }

    fn refresh(&self) -> Verdict {
        let v = decide(&self.machine);
        if let Ok(mut slot) = self.last.lock() {
            *slot = v.clone();
        }
        v
    }
}

/// The whole offline decision: cached token plus this machine plus the clock.
/// No network, no Keychain write, nothing that can fail loudly.
fn decide(machine: &str) -> Verdict {
    match load(TOKEN_ACCOUNT) {
        Some(token) => check(&token, machine, BUILD_DATE, now(), PUBLIC_KEY, PRODUCT),
        None => Verdict { status: Status::Invalid, claims: None },
    }
}

/// Read once, before the engine thread starts. Deliberately free of the managed
/// state so `main.rs` can call it without ordering itself around Tauri setup.
pub fn startup_verdict() -> Verdict {
    decide(&machine_hash())
}

// --------------------------------------------------------------- The wire

#[derive(Deserialize)]
struct TokenReply {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

async fn post(
    licence: &Licence,
    path: &str,
    body: serde_json::Value,
) -> Result<TokenReply, String> {
    let client = licence.client.as_ref().ok_or("no HTTP client")?;
    let res = client
        .post(format!("{BASE}{path}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach the licence service: {e}"))?;
    let status = res.status();
    let reply: TokenReply = res
        .json()
        .await
        .map_err(|e| format!("the licence service returned something unreadable: {e}"))?;
    if let Some(err) = reply.error {
        return Err(err);
    }
    if !status.is_success() {
        return Err(format!("the licence service refused the request ({status})"));
    }
    Ok(reply)
}

/// Persist whatever the service just issued, then re-decide from disk — so the
/// status the panel shows is the one a restart would produce, not an optimistic
/// echo of the reply.
fn persist(licence: &Licence, reply: TokenReply) -> Result<Verdict, String> {
    let token = reply.token.ok_or("the licence service returned no token")?;
    store(TOKEN_ACCOUNT, &token)?;
    if let Some(key) = reply.key {
        store(KEY_ACCOUNT, &key)?;
    }
    Ok(licence.refresh())
}

// -------------------------------------------------------------- Commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenceStatus {
    pub status: Status,
    pub machine: String,
    pub claims: Option<Claims>,
    /// False on any build made before the deployment had a signing key. The
    /// panel says so plainly rather than showing a bare "invalid", which would
    /// read as the operator's fault.
    pub configured: bool,
    pub build_date: i64,
    pub blocks_new_session: bool,
}

#[tauri::command]
pub fn licence_status(licence: State<'_, Licence>) -> LicenceStatus {
    let v = licence.verdict();
    LicenceStatus {
        status: v.status,
        machine: licence.machine.clone(),
        claims: v.claims,
        configured: public_key_configured(),
        build_date: BUILD_DATE,
        blocks_new_session: v.status.blocks_new_session(),
    }
}

#[tauri::command]
pub async fn licence_start_trial(
    licence: State<'_, Licence>,
    email: String,
    name: String,
) -> Result<LicenceStatus, String> {
    let reply = post(
        &licence,
        "/api/licence/trial",
        serde_json::json!({
            "product": PRODUCT,
            "email": email.trim(),
            "machine": licence.machine,
            "name": name.trim(),
        }),
    )
    .await?;
    persist(&licence, reply)?;
    Ok(licence_status(licence))
}

#[tauri::command]
pub async fn licence_activate(
    licence: State<'_, Licence>,
    key: String,
    label: String,
) -> Result<LicenceStatus, String> {
    let reply = post(
        &licence,
        "/api/licence/activate",
        serde_json::json!({ "key": key.trim(), "machine": licence.machine, "label": label }),
    )
    .await?;
    // the key the operator typed is what a later heartbeat needs
    store(KEY_ACCOUNT, key.trim())?;
    persist(&licence, reply)?;
    Ok(licence_status(licence))
}

pub async fn heartbeat_now(licence: &Licence) -> Result<Verdict, String> {
    let key = load(KEY_ACCOUNT).ok_or("no licence key stored on this machine")?;
    let reply = post(
        licence,
        "/api/licence/heartbeat",
        serde_json::json!({ "key": key, "machine": licence.machine }),
    )
    .await?;
    persist(licence, reply)
}

#[tauri::command]
pub async fn licence_heartbeat(licence: State<'_, Licence>) -> Result<LicenceStatus, String> {
    heartbeat_now(&licence).await?;
    Ok(licence_status(licence))
}

/// The daily check-in, and the reason `check_in_required` is only ever a banner:
/// the app fixes it by itself. Never on the startup path — the first attempt is
/// a minute in, long after the engine is lit — and a failure is silent, because
/// the cached token is still the answer and a console that pops a dialog about
/// a lease during a show would be worse than the lapse.
pub fn start_heartbeat(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            {
                let licence = app.state::<Licence>();
                // Only worth a call when there is a key to check in with, and
                // only when the offline answer is not already good.
                if load(KEY_ACCOUNT).is_some()
                    && !matches!(licence.verdict().status, Status::Active | Status::Expired)
                {
                    match heartbeat_now(&licence).await {
                        Ok(v) => eprintln!("[licence] checked in — {:?}", v.status),
                        Err(e) => eprintln!("[licence] check-in failed, using the cached licence: {e}"),
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

#[tauri::command]
pub async fn licence_deactivate(licence: State<'_, Licence>) -> Result<LicenceStatus, String> {
    if let Some(key) = load(KEY_ACCOUNT) {
        // Best effort: freeing the seat is courtesy, and a machine with no
        // network must still be able to forget its licence.
        let _ = post(
            &licence,
            "/api/licence/deactivate",
            serde_json::json!({ "key": key, "machine": licence.machine }),
        )
        .await;
    }
    forget(TOKEN_ACCOUNT)?;
    forget(KEY_ACCOUNT)?;
    licence.refresh();
    Ok(licence_status(licence))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fingerprint has to be stable across calls or every launch burns a
    /// seat, and it has to be the shape the service documents: 32 hex chars.
    #[test]
    fn the_machine_hash_is_stable_and_the_documented_shape() {
        let a = machine_hash();
        assert_eq!(a.len(), 32, "the service takes the first 32 hex characters");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "not hex: {a}");
        assert_eq!(a, machine_hash(), "fingerprint moved between two calls");
    }

    /// Until the deployment has a signing key this must read false, and the
    /// build must still be usable — an unconfigured key is the shipping state,
    /// not an error state.
    #[test]
    fn an_unset_public_key_is_reported_rather_than_guessed() {
        assert_eq!(public_key_configured(), PUBLIC_KEY.len() == 64);
        if !public_key_configured() {
            assert!(!startup_verdict().status.blocks_new_session());
        }
    }

    #[test]
    fn the_build_date_is_stamped() {
        assert!(BUILD_DATE > 1_700_000_000, "build.rs did not stamp a plausible date");
        assert!(BUILD_DATE < 4_000_000_000);
    }
}
