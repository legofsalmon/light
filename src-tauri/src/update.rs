//! Is there a newer LIGHT, and which one applies to this copy.
//!
//! Modelled on how vizz does it, with the parts that do not survive the move
//! replaced rather than copied:
//!
//! - **No manifest and no server of our own.** GitHub's Releases API is the
//!   manifest and GitHub hosts the asset. Nothing to generate, nothing to
//!   deploy, nothing to keep in sync with the build.
//! - **No new signing key.** The payload is already Developer-ID signed and
//!   notarised by the release workflow; `update_install` anchors on that. A
//!   minisign keypair would be a second secret whose loss would permanently end
//!   the ability to update every installed copy, in exchange for a weaker
//!   statement than Apple's.
//! - **Real semver precedence, and prereleases are a channel.** vizz truncates
//!   `1.3.0-beta.2` to `1.3.0`; LIGHT is shipping betas to other people right
//!   now, so that would strand exactly the population being asked to test.
//! - **`serde_json`, not string-scraping.** vizz hand-rolls a parser to avoid a
//!   dependency it does not have. This crate already has one.
//!
//! Nothing here downloads or installs. The check is the whole of this file, it
//! runs once a launch a minute after start, and a failure is a missing banner
//! rather than a message.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::Mutex;
use tauri::State;

/// Read from tauri.conf.json at compile time by build.rs — the same string the
/// bundle carries as CFBundleShortVersionString, so "what am I" and "what did I
/// download" are answered from one place.
pub const CURRENT: &str = env!("LIGHT_VERSION");

const API: &str = "https://api.github.com/repos/legofsalmon/light/releases?per_page=20";
/// Where the panel sends anyone who would rather download it by hand.
pub const RELEASES_URL: &str = "https://github.com/legofsalmon/light/releases";
/// The asset the release workflow publishes: `ditto -c -k --keepParent` over the
/// finished bundle, so it is grafted, re-signed, notarised and stapled. Matched
/// by exact name, never by suffix — the name then never reaches the filesystem
/// as an attacker-chosen path component.
const ASSET: &str = "LIGHT.zip";
/// An unreachable network must not keep a thread alive for long.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

// ------------------------------------------------------------------ Version

/// Semantic version, with the precedence rules that matter for a beta channel.
#[derive(Debug, Clone, Eq, Serialize)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Dot-separated identifiers after `-`. Empty means a stable release.
    pub pre: Vec<String>,
    pub raw: String,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let raw = s.trim().to_string();
        let s = raw.strip_prefix('v').unwrap_or(&raw);
        // build metadata is ignored for precedence, per semver
        let s = s.split('+').next()?;
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p.split('.').map(str::to_owned).collect()),
            None => (s, Vec::new()),
        };
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Version { major, minor, patch, pre, raw })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                // "a pre-release version has lower precedence than a normal
                // version" — the rule that makes 1.3.0 beat 1.3.0-beta.2
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => cmp_pre(&self.pre, &other.pre),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Equality is precedence, NOT the raw string. Deriving it compared `raw` too,
/// so `v1.3.0` and `1.3.0` were Ordering::Equal and `!=` at the same time —
/// which breaks the contract Ord requires of Eq and would misbehave the moment
/// a Version went into a sort or a set.
impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

/// Identifier by identifier: numeric ones compare numerically and rank below
/// alphanumeric ones; a longer run of equal identifiers wins.
fn cmp_pre(a: &[String], b: &[String]) -> Ordering {
    for (x, y) in a.iter().zip(b.iter()) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

// ------------------------------------------------------------------ Release

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: Version,
    pub tag: String,
    pub notes: String,
    pub asset_url: String,
    pub size: u64,
    pub prerelease: bool,
    pub page_url: String,
    /// When GitHub published it, unix seconds. Compared against the licence's
    /// `maintUntil`: a bought licence owns the app forever but only entitles
    /// builds released inside its update window.
    pub published_at: i64,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// `2026-09-05T12:34:56Z` to unix seconds. Hand-rolled because pulling a date
/// crate into a console for one field is not a trade worth making, and the
/// shape GitHub emits is fixed.
fn unix_from_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, m, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (hh, mm, ss) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // days from civil, Howard Hinnant's algorithm
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// Pick the best release this copy should be offered, or None.
///
/// The channel rule is the whole point: a copy already running a prerelease is
/// offered prereleases, a stable copy is not. Without it a beta tester is
/// offered nothing until the next stable — which is precisely the person who
/// most needs the next build.
pub fn best(json: &str, current: &Version) -> Option<Release> {
    let list: Vec<GhRelease> = serde_json::from_str(json).ok()?;
    list.into_iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version = Version::parse(&r.tag_name)?;
            let asset = r.assets.iter().find(|a| a.name == ASSET)?;
            Some(Release {
                version,
                tag: r.tag_name,
                notes: r.body.unwrap_or_default(),
                asset_url: asset.browser_download_url.clone(),
                size: asset.size,
                prerelease: r.prerelease,
                page_url: r.html_url,
                published_at: r.published_at.as_deref().and_then(unix_from_iso).unwrap_or(0),
            })
        })
        .filter(|r| current.is_prerelease() || !r.version.is_prerelease())
        .filter(|r| r.version > *current)
        .max_by(|a, b| a.version.cmp(&b.version))
}

// -------------------------------------------------------------------- State

#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Release>>,
    /// Why the last check found nothing, for the panel. Never a dialog.
    note: Mutex<Option<String>>,
}

impl Updates {
    pub fn new() -> Self {
        Updates::default()
    }

    /// What the last check found, if anything.
    pub fn available(&self) -> Option<Release> {
        self.found.lock().ok().and_then(|v| v.clone())
    }
}

async fn fetch() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // GitHub rejects requests without one
        .user_agent(concat!("LIGHT/", env!("LIGHT_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;
    if !res.status().is_success() {
        // 403 here is nearly always the 60/hour anonymous rate limit, which a
        // venue behind shared NAT can genuinely exhaust.
        return Err(format!("GitHub returned {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// `State` borrows the handle, so the lock guard has to live and die inside a
/// scope the borrow outlives. One helper rather than that dance twice.
fn store(app: &tauri::AppHandle, f: impl FnOnce(&Updates)) {
    use tauri::Manager;
    f(&app.state::<Updates>());
}

/// The once-a-launch check.
///
/// A minute after start, never before — the same shape and the same reasoning
/// as the licence heartbeat next to it: nothing on the startup path, nothing on
/// the tick, and a failure that is silent because the console works perfectly
/// well without knowing whether a newer one exists.
pub fn start_update_check(app: tauri::AppHandle) {
    if std::env::var("LIGHT_NO_UPDATE_CHECK").is_ok() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let current = match Version::parse(CURRENT) {
            Some(v) => v,
            None => return,
        };
        match fetch().await {
            Ok(body) => {
                let found = best(&body, &current);
                if let Some(r) = &found {
                    eprintln!("[update] {} is available (running {})", r.version.raw, CURRENT);
                }
                store(&app, |u| {
                    if let Ok(mut slot) = u.found.lock() {
                        *slot = found;
                    }
                });
            }
            Err(e) => {
                // debug, not warn: being on a hotspot is not a fault
                eprintln!("[update] check skipped: {e}");
                store(&app, |u| {
                    if let Ok(mut slot) = u.note.lock() {
                        *slot = Some(e);
                    }
                });
            }
        }
    });
}

// ----------------------------------------------------------------- Commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub available: Option<Release>,
    /// False when the offer exists but sits outside the licence's update
    /// window. The app stays yours; newer builds are what lapses.
    pub entitled: bool,
    /// The update entitlement deadline from the licence, for the panel to name.
    pub maint_until: Option<i64>,
    pub note: Option<String>,
    pub releases_url: &'static str,
    /// True when this copy is on a prerelease, so the panel can say that it is
    /// being offered prereleases on purpose.
    pub on_prerelease: bool,
}

/// Is this release inside the licence's update window?
///
/// A bought licence owns the app permanently; `maintUntil` is the date after
/// which newly RELEASED builds are no longer included. So the comparison is the
/// release's publication date against that deadline — not today's date, which
/// would revoke builds the customer was entitled to when they appeared.
pub fn entitled_to(release: &Release, maint_until: Option<i64>) -> bool {
    match maint_until {
        // no licence claims to read: nothing to withhold on
        None => true,
        Some(m) => release.published_at <= m,
    }
}

#[tauri::command]
pub fn update_status(
    updates: State<'_, Updates>,
    licence: State<'_, crate::licence_net::Licence>,
) -> UpdateStatus {
    let maint_until = licence.verdict().claims.map(|c| c.maint_until);
    let available = updates.found.lock().ok().and_then(|v| v.clone());
    let entitled = available.as_ref().map(|r| entitled_to(r, maint_until)).unwrap_or(true);
    UpdateStatus {
        current: CURRENT.to_string(),
        entitled,
        maint_until,
        available,
        note: updates.note.lock().ok().and_then(|v| v.clone()),
        releases_url: RELEASES_URL,
        on_prerelease: Version::parse(CURRENT).map(|v| v.is_prerelease()).unwrap_or(false),
    }
}

/// Check now, because the operator asked. Same call, no timer.
#[tauri::command]
pub async fn update_check_now(
    updates: State<'_, Updates>,
    licence: State<'_, crate::licence_net::Licence>,
) -> Result<UpdateStatus, String> {
    let current = Version::parse(CURRENT).ok_or("this build has no readable version")?;
    let body = fetch().await?;
    let found = best(&body, &current);
    if let Ok(mut slot) = updates.found.lock() {
        *slot = found;
    }
    if let Ok(mut slot) = updates.note.lock() {
        *slot = None;
    }
    Ok(update_status(updates, licence))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("could not parse {s}"))
    }

    /// The rule vizz gets wrong by truncating the prerelease, and the reason it
    /// matters here: v1.3.0-beta.1 and v1.3.0-beta.2 are in other people's
    /// hands right now.
    #[test]
    fn precedence_follows_semver_including_prereleases() {
        let ordered = [
            "0.9.0", "0.10.0", "1.3.0-alpha.1", "1.3.0-beta.1", "1.3.0-beta.2", "1.3.0-beta.10",
            "1.3.0-rc.1", "1.3.0", "1.3.1", "2.0.0",
        ];
        for pair in ordered.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} should sort below {}", pair[0], pair[1]);
        }
        // numeric identifiers compare numerically, not as strings
        assert!(v("1.3.0-beta.2") < v("1.3.0-beta.10"));
        // and rank below alphanumeric ones
        assert!(v("1.3.0-1") < v("1.3.0-alpha"));
        assert_eq!(v("1.3.0"), v("v1.3.0"));
        // build metadata is not part of precedence
        assert_eq!(v("1.3.0+abc"), v("1.3.0"));
    }

    #[test]
    fn junk_versions_are_rejected_rather_than_coerced() {
        for bad in ["", "latest", "v", "1.2.3.4", "one.two.three", "1.x.0"] {
            assert!(Version::parse(bad).is_none(), "accepted {bad:?}");
        }
    }

    /// Shaped like a real GitHub response, with the traps: a draft, a release
    /// whose only asset is the dmg, and a prerelease newer than the newest
    /// stable.
    fn feed() -> String {
        serde_json::json!([
            { "tag_name": "v1.4.0-beta.1", "prerelease": true, "draft": false, "html_url": "p/beta1",
              "assets": [{ "name": "LIGHT.zip", "browser_download_url": "u/beta1", "size": 26 }] },
            { "tag_name": "v1.3.0", "prerelease": false, "draft": false, "html_url": "p/130",
              "assets": [{ "name": "LIGHT.zip", "browser_download_url": "u/130", "size": 25 }] },
            { "tag_name": "v1.5.0", "prerelease": false, "draft": true, "html_url": "p/150",
              "assets": [{ "name": "LIGHT.zip", "browser_download_url": "u/150", "size": 27 }] },
            { "tag_name": "v1.3.1", "prerelease": false, "draft": false, "html_url": "p/131",
              "assets": [{ "name": "LIGHT-1.3.1.dmg", "browser_download_url": "u/131dmg", "size": 30 }] },
        ])
        .to_string()
    }

    #[test]
    fn a_stable_copy_is_never_offered_a_prerelease() {
        let r = best(&feed(), &v("1.2.2")).expect("something on offer");
        assert_eq!(r.version.raw, "v1.3.0", "a stable build must not be offered 1.4.0-beta.1");
    }

    /// The other half, and the one that un-strands the current testers.
    #[test]
    fn a_beta_copy_is_offered_the_newer_beta() {
        let r = best(&feed(), &v("1.3.0-beta.2")).expect("something on offer");
        assert_eq!(r.version.raw, "v1.4.0-beta.1");
    }

    #[test]
    fn drafts_and_releases_without_the_asset_are_ignored() {
        // v1.5.0 is a draft and v1.3.1 ships only a dmg, so a copy already on
        // 1.3.0 has nothing to move to
        assert!(best(&feed(), &v("1.3.0")).is_none());
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(best(&feed(), &v("1.3.0")).is_none());
        assert!(best(&feed(), &v("9.0.0")).is_none());
    }

    #[test]
    fn the_asset_is_matched_by_exact_name() {
        // a release carrying a lookalike must not be picked up: the name is
        // attacker-influenced data and never becomes a path component
        let feed = serde_json::json!([
            { "tag_name": "v2.0.0", "prerelease": false, "draft": false, "html_url": "p",
              "assets": [{ "name": "LIGHT.zip.exe", "browser_download_url": "u/evil", "size": 1 },
                         { "name": "../../LIGHT.zip", "browser_download_url": "u/evil2", "size": 1 }] }
        ])
        .to_string();
        assert!(best(&feed, &v("1.0.0")).is_none());
    }

    #[test]
    fn a_malformed_feed_is_no_update_rather_than_a_panic() {
        for bad in ["", "null", "{}", "[", "[{\"tag_name\":123}]", "not json"] {
            assert!(best(bad, &v("1.0.0")).is_none(), "panicked or accepted {bad:?}");
        }
    }

    /// The version the binary reports has to be the version the bundle carries,
    /// or an update compares against the wrong number. src-tauri/Cargo.toml sat
    /// at 0.1.0 while the app shipped 1.3.0-beta.2, and share.rs was telling
    /// GDTF Share it was LIGHT/0.1.0.
    #[test]
    fn the_version_agrees_across_every_file_that_states_it() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let pkg: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("package.json");
        assert_eq!(CURRENT, conf["version"].as_str().unwrap(), "LIGHT_VERSION vs tauri.conf.json");
        assert_eq!(CURRENT, pkg["version"].as_str().unwrap(), "LIGHT_VERSION vs package.json");
        assert!(Version::parse(CURRENT).is_some(), "{CURRENT} is not a usable version");
    }

    /// The synthetic feed above has the traps; this one is the real thing,
    /// captured from api.github.com for this repo. Both are worth having: the
    /// synthetic one can hold cases GitHub does not currently produce, and this
    /// one catches the day GitHub changes a field name and the synthetic feed
    /// happily keeps passing.
    const REAL: &str = include_str!("../testdata/github-releases.json");

    #[test]
    fn the_real_feed_parses_and_respects_the_channel() {
        // A stable copy is NOT dragged onto a beta, even though the betas are
        // the newest things published.
        let r = best(REAL, &v("1.2.0")).expect("1.2.0 should be offered something");
        assert_eq!(r.version.raw, "v1.2.2", "a stable copy must be offered the newest STABLE");
        assert!(!r.prerelease);
        assert!(r.asset_url.ends_with("/LIGHT.zip"), "wrong asset: {}", r.asset_url);
        assert!(r.size > 1_000_000, "size looks wrong: {}", r.size);
        assert!(best(REAL, &v("1.2.2")).is_none(), "the newest stable is offered nothing");

        // The case the whole channel rule exists for, and the one the in-app
        // update test depends on: a copy on beta.3 must be offered beta.4.
        let r = best(REAL, &v("1.3.0-beta.3")).expect("beta.3 should be offered beta.4");
        assert_eq!(r.version.raw, "v1.3.0-beta.4");
        assert!(r.prerelease);
        assert!(r.asset_url.ends_with("/LIGHT.zip"));

        // Older betas walk forward to the newest beta, not to the newest stable.
        assert_eq!(best(REAL, &v("1.3.0-beta.2")).unwrap().version.raw, "v1.3.0-beta.4");

        // And the newest build is offered nothing.
        assert!(best(REAL, &v("1.3.0-beta.4")).is_none());
    }

    /// Every release ever published carries the asset, so an updater shipped
    /// today can move a copy from any of them.
    #[test]
    fn every_published_release_carries_the_update_payload() {
        let list: serde_json::Value = serde_json::from_str(REAL).expect("fixture parses");
        let rels = list.as_array().expect("an array");
        assert!(rels.len() >= 5, "fixture looks truncated");
        for r in rels {
            let names: Vec<&str> =
                r["assets"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
            assert!(
                names.contains(&ASSET),
                "{} publishes {names:?} — no {ASSET} means no update path from it",
                r["tag_name"]
            );
        }
    }

    fn rel(published: i64) -> Release {
        let mut r = best(&feed(), &v("1.0.0")).expect("a release");
        r.published_at = published;
        r
    }

    /// The rule the licence model turns on: buying the app keeps the app. What
    /// lapses is the entitlement to builds RELEASED after the window closed.
    #[test]
    fn the_update_window_is_about_the_release_date_not_today() {
        let maint = 1_800_000_000;
        assert!(entitled_to(&rel(maint - 1), Some(maint)), "released inside the window");
        assert!(entitled_to(&rel(maint), Some(maint)), "released exactly at the deadline");
        assert!(!entitled_to(&rel(maint + 1), Some(maint)), "released after it");
        // With no readable licence there is nothing to withhold on — the gate
        // for that case is the session gate, not this.
        assert!(entitled_to(&rel(maint + 999_999), None));
    }

    /// GitHub's timestamps, since a wrong parse here would silently withhold
    /// every update or none of them.
    #[test]
    fn github_timestamps_parse_to_the_right_instant() {
        assert_eq!(unix_from_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_from_iso("2026-09-05T00:00:00Z"), Some(1_788_566_400));
        assert_eq!(unix_from_iso("2000-02-29T12:00:00Z"), Some(951_825_600), "leap day");
        // ordering is what actually matters, whatever the epoch arithmetic
        assert!(unix_from_iso("2026-09-05T12:00:00Z") > unix_from_iso("2026-09-05T11:59:59Z"));
        assert!(unix_from_iso("2027-01-01T00:00:00Z") > unix_from_iso("2026-12-31T23:59:59Z"));
        for bad in ["", "not a date", "2026-09-05", "20260905T000000Z", "2026-13-05T00:00:00Z"] {
            assert!(unix_from_iso(bad).is_none(), "accepted {bad:?}");
        }
    }

    /// Every real release must carry a parseable date, or the entitlement check
    /// silently reads them all as epoch 0 and lets everything through.
    #[test]
    fn the_real_feed_has_usable_publication_dates() {
        let r = best(REAL, &v("1.2.0")).expect("an offer");
        assert!(r.published_at > 1_700_000_000, "no publication date: {}", r.published_at);
    }
}
