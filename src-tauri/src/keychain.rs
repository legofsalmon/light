//! The one place secrets live: the licence token and key (`licence_net.rs`)
//! and the GDTF Share password (`share.rs`). Never the project file — the whole
//! `Project` is broadcast to every connected client, including a tablet on the
//! venue WiFi.
//!
//! Why this module exists (review, September 2026): the `keyring` crate writes
//! to the legacy file-based keychain and sets no access list, so each item
//! trusts only the exact binary that created it. Every new build is a
//! different application to that ACL — which is why "Always Allow" never stuck
//! from one beta to the next — and the in-app updater replaces the binary on
//! every update, so the prompt would have come back forever, for the licence
//! token and the Share password both. macOS's data protection keychain scopes
//! items by a keychain access group instead, and a group belongs to the
//! signing team, not the binary: a build signed by the same team reads what a
//! previous build wrote, and nothing asks.
//!
//! Three rules:
//!
//! 1. The data protection keychain is the store, under [`ACCESS_GROUP`], which
//!    `light.keychain.entitlements` grants. That entitlement is restricted on
//!    macOS — it needs a Developer ID provisioning profile, and a bundle that
//!    carries it without one is killed at launch — so only a release built
//!    with the profile has it; a `tauri dev` binary and a release without the
//!    profile do not. The first call probes once and falls back to the legacy
//!    keychain (exactly what shipped before) when the modern one refuses.
//! 2. A miss in the modern store looks in the legacy one, and a hit there is
//!    moved across: the one-time migration for anyone who signed in on an
//!    earlier beta. That read is the last prompt they see.
//! 3. Nothing here is on the tick path, and nothing here panics: a keychain
//!    that is locked, denied or absent reads as "nothing stored".

use std::sync::OnceLock;

/// Team ID + bundle identifier: the group `light.keychain.entitlements` names.
/// A build signed by the same team can read what an earlier one wrote; nothing
/// else can. Change it here and there together — a test holds the two to it.
pub const ACCESS_GROUP: &str = "PKN49VCQZQ.com.colmhewson.light";

/// What went wrong, in words the panel can show.
pub type Error = String;

/// Where secrets are kept on this run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// the data protection keychain, under the access group
    Modern,
    /// the login keychain through `keyring` — what shipped before this module
    Legacy,
}

/// One secret store. `get` answers `Ok(None)` for an absent item and `Err` for
/// a store that would not answer (locked, denied, no entitlement); `delete`
/// of an absent item is `Ok`.
trait Store {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, Error>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), Error>;
    fn delete(&self, service: &str, account: &str) -> Result<(), Error>;
}

// ---------------------------------------------------------------- legacy

struct Legacy;

impl Store for Legacy {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, Error> {
        match keyring::Entry::new(service, account).and_then(|e| e.get_password()) {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), Error> {
        keyring::Entry::new(service, account)
            .and_then(|e| e.set_password(value))
            .map_err(|e| e.to_string())
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), Error> {
        match keyring::Entry::new(service, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------- modern

#[cfg(target_os = "macos")]
mod modern {
    use super::{Error, Store, ACCESS_GROUP};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;
    /// errSecMissingEntitlement — the binary is not signed for the access group
    pub const MISSING_ENTITLEMENT: i32 = -34018;

    fn options(service: &str, account: &str) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(service, account);
        o.use_protected_keychain();
        o.set_access_group(ACCESS_GROUP);
        o
    }

    pub struct Modern;

    impl Modern {
        /// The raw status of a read, so the probe can tell "no entitlement"
        /// from "nothing stored".
        pub fn get_code(service: &str, account: &str) -> Result<Option<String>, i32> {
            match generic_password(options(service, account)) {
                Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
                Err(e) if e.code() == NOT_FOUND => Ok(None),
                Err(e) => Err(e.code()),
            }
        }
    }

    fn describe(code: i32) -> Error {
        match code {
            MISSING_ENTITLEMENT => "this build is not signed for the keychain access group".to_string(),
            c => security_framework::base::Error::from_code(c)
                .message()
                .unwrap_or_else(|| format!("keychain error {c}")),
        }
    }

    impl Store for Modern {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, Error> {
            Self::get_code(service, account).map_err(describe)
        }
        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), Error> {
            set_generic_password_options(value.as_bytes(), options(service, account))
                .map_err(|e| describe(e.code()))
        }
        fn delete(&self, service: &str, account: &str) -> Result<(), Error> {
            match delete_generic_password_options(options(service, account)) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == NOT_FOUND => Ok(()),
                Err(e) => Err(describe(e.code())),
            }
        }
    }
}

// ---------------------------------------------------------------- policy

/// Probed once per process: a read of a sentinel that is never stored. An
/// absent item proves the access group is usable; a refusal means this binary
/// is not signed for it and the legacy keychain is the store for this run.
pub fn backend() -> Backend {
    static BACKEND: OnceLock<Backend> = OnceLock::new();
    *BACKEND.get_or_init(probe)
}

#[cfg(target_os = "macos")]
fn probe() -> Backend {
    match modern::Modern::get_code("ie.letissier.light.probe", "probe") {
        Ok(_) => Backend::Modern,
        Err(modern::MISSING_ENTITLEMENT) => {
            eprintln!(
                "[keychain] this build is not signed for the {ACCESS_GROUP} access group — using the login keychain (every new build will ask again)"
            );
            Backend::Legacy
        }
        Err(code) => {
            eprintln!("[keychain] data protection keychain unavailable ({code}) — using the login keychain");
            Backend::Legacy
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn probe() -> Backend {
    Backend::Legacy
}

/// The stores for this run: the modern one when the probe allowed it, and the
/// legacy one always, because that is where an earlier beta left things.
fn stores() -> (Option<Box<dyn Store>>, Box<dyn Store>) {
    #[cfg(target_os = "macos")]
    let modern: Option<Box<dyn Store>> = match backend() {
        Backend::Modern => Some(Box::new(modern::Modern)),
        Backend::Legacy => None,
    };
    #[cfg(not(target_os = "macos"))]
    let modern: Option<Box<dyn Store>> = None;
    (modern, Box::new(Legacy))
}

fn load_with(modern: Option<&dyn Store>, legacy: &dyn Store, service: &str, account: &str) -> Option<String> {
    let Some(modern) = modern else {
        return legacy.get(service, account).ok().flatten();
    };
    match modern.get(service, account) {
        Ok(Some(v)) => return Some(v),
        Ok(None) => {}
        Err(e) => {
            // the modern store would not answer this time — read the old
            // place without moving anything, and try again next launch
            eprintln!("[keychain] {service}/{account}: {e}");
            return legacy.get(service, account).ok().flatten();
        }
    }
    // Nothing in the modern store. An earlier beta may have left it in the
    // login keychain: move it across so this read is the last one that asks.
    match legacy.get(service, account) {
        Ok(Some(v)) => {
            match modern.set(service, account, &v) {
                Ok(()) => {
                    if let Err(e) = legacy.delete(service, account) {
                        eprintln!("[keychain] {service}/{account}: moved, but the old copy stays: {e}");
                    }
                }
                Err(e) => eprintln!("[keychain] {service}/{account}: could not move to the access group: {e}"),
            }
            Some(v)
        }
        _ => None,
    }
}

fn store_with(modern: Option<&dyn Store>, legacy: &dyn Store, service: &str, account: &str, value: &str) -> Result<(), Error> {
    match modern {
        Some(m) => m.set(service, account, value),
        None => legacy.set(service, account, value),
    }
}

fn forget_with(modern: Option<&dyn Store>, legacy: &dyn Store, service: &str, account: &str) -> Result<(), Error> {
    match modern {
        Some(m) => {
            m.delete(service, account)?;
            // a leftover from before the migration is not worth failing over
            if let Err(e) = legacy.delete(service, account) {
                eprintln!("[keychain] {service}/{account}: the old copy stays: {e}");
            }
            Ok(())
        }
        None => legacy.delete(service, account),
    }
}

/// Read a secret. `None` for "nothing stored" and for a keychain that would
/// not answer — the caller cannot tell the two apart, and should not try.
pub fn load(service: &str, account: &str) -> Option<String> {
    let (modern, legacy) = stores();
    load_with(modern.as_deref(), legacy.as_ref(), service, account)
}

/// Write a secret, creating or replacing.
pub fn store(service: &str, account: &str, value: &str) -> Result<(), Error> {
    let (modern, legacy) = stores();
    store_with(modern.as_deref(), legacy.as_ref(), service, account, value)
}

/// Remove a secret from wherever it is; absent is fine.
pub fn forget(service: &str, account: &str) -> Result<(), Error> {
    let (modern, legacy) = stores();
    forget_with(modern.as_deref(), legacy.as_ref(), service, account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    /// An in-memory store that counts reads and can refuse.
    #[derive(Default)]
    struct Fake {
        items: RefCell<HashMap<(String, String), String>>,
        reads: Cell<usize>,
        refuse: Cell<bool>,
    }
    impl Fake {
        fn with(service: &str, account: &str, value: &str) -> Self {
            let f = Self::default();
            f.items.borrow_mut().insert((service.into(), account.into()), value.into());
            f
        }
        fn has(&self, service: &str, account: &str) -> Option<String> {
            self.items.borrow().get(&(service.into(), account.into())).cloned()
        }
    }
    impl Store for Fake {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, Error> {
            self.reads.set(self.reads.get() + 1);
            if self.refuse.get() {
                return Err("refused".into());
            }
            Ok(self.has(service, account))
        }
        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), Error> {
            if self.refuse.get() {
                return Err("refused".into());
            }
            self.items.borrow_mut().insert((service.into(), account.into()), value.into());
            Ok(())
        }
        fn delete(&self, service: &str, account: &str) -> Result<(), Error> {
            if self.refuse.get() {
                return Err("refused".into());
            }
            self.items.borrow_mut().remove(&(service.into(), account.into()));
            Ok(())
        }
    }

    const S: &str = "ie.letissier.light.test";

    #[test]
    fn a_modern_hit_never_touches_the_legacy_keychain() {
        // reading the login keychain is what prompts — a hit up front must skip it
        let modern = Fake::with(S, "token", "new");
        let legacy = Fake::with(S, "token", "old");
        assert_eq!(load_with(Some(&modern), &legacy, S, "token").as_deref(), Some("new"));
        assert_eq!(legacy.reads.get(), 0, "the legacy keychain was read");
    }

    #[test]
    fn a_legacy_item_is_moved_across_once() {
        let modern = Fake::default();
        let legacy = Fake::with(S, "token", "from-beta-3");
        assert_eq!(load_with(Some(&modern), &legacy, S, "token").as_deref(), Some("from-beta-3"));
        assert_eq!(modern.has(S, "token").as_deref(), Some("from-beta-3"), "not copied into the access group");
        assert!(legacy.has(S, "token").is_none(), "the old copy should be gone");
        // the second read is answered by the modern store alone
        legacy.reads.set(0);
        assert_eq!(load_with(Some(&modern), &legacy, S, "token").as_deref(), Some("from-beta-3"));
        assert_eq!(legacy.reads.get(), 0);
    }

    #[test]
    fn a_denied_legacy_read_is_nothing_stored() {
        // the user clicked Deny on the migration prompt: no value, no panic,
        // and nothing written anywhere
        let modern = Fake::default();
        let legacy = Fake::with(S, "token", "secret");
        legacy.refuse.set(true);
        assert_eq!(load_with(Some(&modern), &legacy, S, "token"), None);
        assert!(modern.has(S, "token").is_none());
    }

    #[test]
    fn a_modern_refusal_falls_back_without_moving_anything() {
        let modern = Fake::default();
        modern.refuse.set(true);
        let legacy = Fake::with(S, "token", "old");
        assert_eq!(load_with(Some(&modern), &legacy, S, "token").as_deref(), Some("old"));
        assert_eq!(legacy.has(S, "token").as_deref(), Some("old"), "must not delete what it could not move");
    }

    #[test]
    fn writes_go_to_one_place_and_forget_clears_both() {
        let modern = Fake::default();
        let legacy = Fake::with(S, "key", "stale");
        store_with(Some(&modern), &legacy, S, "key", "fresh").unwrap();
        assert_eq!(modern.has(S, "key").as_deref(), Some("fresh"));
        assert_eq!(legacy.has(S, "key").as_deref(), Some("stale"), "a write never touches the old place");
        forget_with(Some(&modern), &legacy, S, "key").unwrap();
        assert!(modern.has(S, "key").is_none() && legacy.has(S, "key").is_none());
    }

    #[test]
    fn without_the_entitlement_everything_is_legacy() {
        let legacy = Fake::default();
        store_with(None, &legacy, S, "key", "v").unwrap();
        assert_eq!(load_with(None, &legacy, S, "key").as_deref(), Some("v"));
        forget_with(None, &legacy, S, "key").unwrap();
        assert_eq!(load_with(None, &legacy, S, "key"), None);
    }

    /// The two entitlement files and this module must agree, and the base
    /// file must never carry the restricted entitlement: a bundle signed with
    /// it and no provisioning profile is killed at launch.
    #[test]
    fn the_entitlements_match_the_access_group() {
        let base = include_str!("../light.entitlements");
        let with_group = include_str!("../light.keychain.entitlements");
        // the key elements, not the words — the base file's comment names them
        assert!(!base.contains("<key>keychain-access-groups</key>"), "the base entitlements must stay bare");
        assert!(!base.contains("<key>com.apple.application-identifier</key>"), "the base entitlements must stay bare");
        assert!(with_group.contains("<key>keychain-access-groups</key>"));
        assert!(with_group.contains(&format!("<string>{ACCESS_GROUP}</string>")), "light.keychain.entitlements names a different group");
        assert_eq!(with_group.matches(ACCESS_GROUP).count(), 2, "identifier and group are the same string, twice");
        // the keychain file is the base file plus the two restricted keys
        for key in ["com.apple.security.cs.allow-jit"] {
            assert!(base.contains(key) && with_group.contains(key), "{key} must be in both");
        }
    }

    /// The real keychain on this Mac, whichever backend the probe picks —
    /// opt-in, because it writes to the developer's keychain.
    ///
    ///   LIGHT_KEYCHAIN_LIVE=1 cargo test -p light-app keychain::tests::live -- --nocapture
    #[test]
    fn live_round_trip() {
        if std::env::var_os("LIGHT_KEYCHAIN_LIVE").is_none() {
            return;
        }
        let account = format!("live-{}", std::process::id());
        eprintln!("[keychain test] backend: {:?}", backend());
        assert_eq!(load(S, &account), None);
        store(S, &account, "one").unwrap();
        assert_eq!(load(S, &account).as_deref(), Some("one"));
        store(S, &account, "two").unwrap();
        assert_eq!(load(S, &account).as_deref(), Some("two"), "a second write must replace");
        forget(S, &account).unwrap();
        assert_eq!(load(S, &account), None);
        forget(S, &account).unwrap(); // absent is fine
    }
}
