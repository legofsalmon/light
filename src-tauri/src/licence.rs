//! Licence verification — pure, no I/O, no network, no clock of its own.
//!
//! Everything here is a function of `(token, machine, build date, now, key)`,
//! which is what makes it testable against the vendor's own published vectors
//! at <https://letissier.ie/integrate/vectors.json>. The network half lives in
//! `licence_net.rs` and never calls into the decision below except to hand it a
//! fresher token.
//!
//! The governing rule for this app, from `docs/licensing-integration.md`: no
//! licence state ever stops DMX going out or a cue firing mid-show. The only
//! gate is at the point a new session starts, and `Status` alone decides
//! nothing — `main.rs` does, at startup, once.

use base64::Engine;
use serde::{Deserialize, Serialize};

/// What the signature is computed over.
///
/// This was the open question in the integration plan, and the prose guide and
/// the test vectors disagree: the guide says the raw decoded payload bytes, the
/// vectors only verify against the **ASCII of the base64url payload segment**.
/// Measured, not assumed — `the_published_vectors_agree` runs both valid tokens
/// through and `raw decoded` fails them. The vectors win; they are what every
/// SDK is generated against.
///
/// Deliberately one acceptance path. A verifier that tries both is a weaker
/// verifier: it accepts everything either scheme would, and the second path is
/// exactly where a forgery would aim.
fn signed_bytes(payload_segment: &str) -> &[u8] {
    payload_segment.as_bytes()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub v: u32,
    pub key: String,
    pub product: String,
    pub edition: String,
    #[serde(default)]
    pub customer: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub seats: u32,
    /// Update entitlement: a build released at or before this runs forever.
    #[serde(rename = "maintUntil")]
    pub maint_until: i64,
    /// Lease check-in deadline. Passing it does not end the licence — except
    /// for a trial, where there is nothing to check back in to.
    pub exp: i64,
    pub machine: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub iat: i64,
    #[serde(default)]
    pub jti: String,
}

impl Claims {
    pub fn is_trial(&self) -> bool {
        self.edition.eq_ignore_ascii_case("trial")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    UpdateRequired,
    CheckInRequired,
    Expired,
    WrongMachine,
    Invalid,
}

impl Status {
    /// The one place the product decides what a status *costs*. Only a lapsed
    /// trial stops a new session starting; everything else is a banner, because
    /// a console that refuses to light a rig over a lease is worse than an
    /// unlicensed one. Nothing here can touch a session already running.
    pub fn blocks_new_session(self) -> bool {
        matches!(self, Status::Expired)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Verdict {
    pub status: Status,
    /// Present only when the signature verified — never trust these otherwise.
    pub claims: Option<Claims>,
}

impl Verdict {
    fn invalid() -> Self {
        Verdict { status: Status::Invalid, claims: None }
    }
}

fn b64url(segment: &str) -> Option<Vec<u8>> {
    let trimmed = segment.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed).ok()
}

/// Decide a licence's status.
///
/// `expected_product` is a parameter rather than a constant so the vendor's
/// vectors (issued for `vizz`) can drive the tests while the app checks for
/// `light`. It is a real check, not test scaffolding: a token minted for
/// another product of theirs must not license this one.
pub fn check(
    token: &str,
    machine: &str,
    build_date: i64,
    now: i64,
    public_key_hex: &str,
    expected_product: &str,
) -> Verdict {
    let Some((payload_seg, sig_seg)) = token.split_once('.') else {
        return Verdict::invalid();
    };
    // A second dot means this is not the shape we verify. Reject rather than
    // guess which segment is which.
    if sig_seg.contains('.') || payload_seg.is_empty() || sig_seg.is_empty() {
        return Verdict::invalid();
    }

    let Some(key_bytes) = hex_to_bytes(public_key_hex) else {
        return Verdict::invalid();
    };
    let Some(sig) = b64url(sig_seg) else {
        return Verdict::invalid();
    };

    let verifier = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key_bytes);
    if verifier.verify(signed_bytes(payload_seg), &sig).is_err() {
        return Verdict::invalid();
    }

    // Only past the signature check is any of this worth reading.
    let Some(raw) = b64url(payload_seg) else {
        return Verdict::invalid();
    };
    let Ok(claims) = serde_json::from_slice::<Claims>(&raw) else {
        return Verdict::invalid();
    };

    if claims.v != 1 {
        return Verdict::invalid();
    }
    if !claims.product.eq_ignore_ascii_case(expected_product) {
        return Verdict::invalid();
    }
    if !claims.machine.eq_ignore_ascii_case(machine) {
        return Verdict { status: Status::WrongMachine, claims: Some(claims) };
    }

    // Lease before entitlement. Both can be true at once and the vectors do not
    // cover the overlap, so the order is a decision: a lapsed lease is the one
    // the app can fix by itself with a heartbeat, so surface that first and let
    // the update banner appear once the lease is healthy again.
    // `>=`, not `>`, to match the vendor SDK exactly: theirs computes
    // `exp - now` and treats `<= 0` as lapsed, so at the tick where now == exp
    // it says lapsed and a `>` here would say active. One second, and no test
    // vector covers it — which is exactly the kind of gap where two
    // implementations of the same rule quietly disagree forever.
    let status = if now >= claims.exp {
        if claims.is_trial() {
            Status::Expired
        } else {
            Status::CheckInRequired
        }
    } else if build_date > claims.maint_until {
        Status::UpdateRequired
    } else {
        Status::Active
    };

    Verdict { status, claims: Some(claims) }
}

fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 || s.is_empty() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim from https://letissier.ie/integrate/vectors.json — "Every SDK
    // must agree with these." Kept as literals so a drift in the service is a
    // test failure here rather than a silent behaviour change in the field.
    const PUBKEY: &str = "646f775f5d6cb61423097707bca116e3f5c4d23c43cda2f2d9938a1c53ed4180";
    const MACHINE: &str = "8b9dd6da2bcf47bdfe7ceb27c2a58680";
    const NOW: i64 = 1_760_086_400;
    const PRODUCT: &str = "vizz";
    const IN_WINDOW: i64 = 1_791_449_600;

    const VALID: &str = "eyJ2IjoxLCJrZXkiOiJMVC1WMVpaLUs3TTItOVBRUi00WFRDIiwicHJvZHVjdCI6InZpenoiLCJlZGl0aW9uIjoic3RhbmRhcmQiLCJjdXN0b21lciI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsIm5hbWUiOiJUZXN0IEJ1eWVyIiwic2VhdHMiOjIsIm1haW50VW50aWwiOjE3OTE1MzYwMDAsImV4cCI6MTc2MjU5MjAwMCwibWFjaGluZSI6IjhiOWRkNmRhMmJjZjQ3YmRmZTdjZWIyN2MyYTU4NjgwIiwibW9kZSI6Im9ubGluZSIsImlhdCI6MTc2MDAwMDAwMCwianRpIjoiYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVlIn0.NJJ19Pf83txJ6DTTJ4ZOpjoAdQPq2foeZ9NIOH77hiiDO-jK5Abg937Mf42HOzZNaxOUgQwhZuEg-pztwp_eDQ";
    const VALID_TRIAL: &str = "eyJ2IjoxLCJrZXkiOiJMVC1EQVRBLVRSMUEtTDAwMC0wMDAwIiwicHJvZHVjdCI6InZpenoiLCJlZGl0aW9uIjoidHJpYWwiLCJjdXN0b21lciI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsIm5hbWUiOiJUZXN0IEJ1eWVyIiwic2VhdHMiOjEsIm1haW50VW50aWwiOjE3NjI1OTIwMDAsImV4cCI6MTc2MjU5MjAwMCwibWFjaGluZSI6IjhiOWRkNmRhMmJjZjQ3YmRmZTdjZWIyN2MyYTU4NjgwIiwibW9kZSI6Im9ubGluZSIsImlhdCI6MTc2MDAwMDAwMCwianRpIjoiYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVlIn0.nz_Xpw4RC5zp3zit0hTtX2coV1cwt9MEodvx9FqUzUCZMrtdHSJ3YuTln-65pNxnJBFSgfSgvAW9RLXAqZ9sDg";
    const TAMPERED: &str = "eyJ2IjoxLCJrZXkiOiJMVC1WMVpaLUs3TTItOVBRUi00WFRDIiwicHJvZHVjdCI6InZpenoiLCJlZGl0aW9uIjoic3RhbmRhcmQiLCJjdXN0b21lciI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsIm5hbWUiOiJUZXN0IEJ1eWVyIiwic2VhdHMiOjk5LCJtYWludFVudGlsIjoxNzkxNTM2MDAwLCJleHAiOjE3NjI1OTIwMDAsIm1hY2hpbmUiOiI4YjlkZDZkYTJiY2Y0N2JkZmU3Y2ViMjdjMmE1ODY4MCIsIm1vZGUiOiJvbmxpbmUiLCJpYXQiOjE3NjAwMDAwMDAsImp0aSI6ImFhYWFhYWFhLWJiYmItY2NjYy1kZGRkLWVlZWVlZWVlZWVlZSJ9.NJJ19Pf83txJ6DTTJ4ZOpjoAdQPq2foeZ9NIOH77hiiDO-jK5Abg937Mf42HOzZNaxOUgQwhZuEg-pztwp_eDQ";
    const WRONG_KEY: &str = "eyJ2IjoxLCJrZXkiOiJMVC1WMVpaLUs3TTItOVBRUi00WFRDIiwicHJvZHVjdCI6InZpenoiLCJlZGl0aW9uIjoic3RhbmRhcmQiLCJjdXN0b21lciI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsIm5hbWUiOiJUZXN0IEJ1eWVyIiwic2VhdHMiOjIsIm1haW50VW50aWwiOjE3OTE1MzYwMDAsImV4cCI6MTc2MjU5MjAwMCwibWFjaGluZSI6IjhiOWRkNmRhMmJjZjQ3YmRmZTdjZWIyN2MyYTU4NjgwIiwibW9kZSI6Im9ubGluZSIsImlhdCI6MTc2MDAwMDAwMCwianRpIjoiYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVlIn0.OAcdCws2p9HjzxPC92tLs8bJA0eFEgWKw1ySJSnDirYAvTgdPFnU4xJytSHPtmwIGpwcm09CMlz72QXoQIkjDQ";

    fn status_of(token: &str, build: i64, now: i64) -> Status {
        check(token, MACHINE, build, now, PUBKEY, PRODUCT).status
    }

    #[test]
    fn the_published_vectors_agree() {
        assert_eq!(status_of(VALID, IN_WINDOW, NOW), Status::Active);
        assert_eq!(status_of(TAMPERED, IN_WINDOW, NOW), Status::Invalid, "seats 2 -> 99");
        assert_eq!(status_of(WRONG_KEY, IN_WINDOW, NOW), Status::Invalid, "signed by another key");
        assert_eq!(status_of("not-a-token", IN_WINDOW, NOW), Status::Invalid);
    }

    /// The vendor's `entitlement` block, case for case.
    #[test]
    fn the_update_window_is_inclusive_of_its_deadline() {
        for (build, expect, why) in [
            (1_791_449_600, Status::Active, "released inside the update window"),
            (1_791_536_000, Status::Active, "released exactly at the deadline"),
            (1_791_622_400, Status::UpdateRequired, "newer than the entitlement"),
        ] {
            assert_eq!(status_of(VALID, build, NOW), expect, "{why}");
        }
    }

    /// The vendor's `lease` and `trialLease` blocks. The difference between them
    /// is the whole reason a trial is worth shipping: the same lapsed deadline
    /// is a heartbeat prompt on a bought licence and the end of a trial.
    #[test]
    fn a_lapsed_lease_ends_a_trial_and_only_nags_a_purchase() {
        assert_eq!(status_of(VALID, IN_WINDOW, 1_762_505_600), Status::Active, "inside the window");
        assert_eq!(
            status_of(VALID, IN_WINDOW, 1_762_678_400),
            Status::CheckInRequired,
            "lease lapsed, licence still valid"
        );
        assert_eq!(
            status_of(VALID_TRIAL, 1_760_000_000, 1_762_678_400),
            Status::Expired,
            "a trial that lapses is over"
        );
    }

    /// Only the lapsed trial costs anything, and it costs a *new* session. This
    /// is the app's rule, not the service's — see `docs/licensing-integration.md`.
    #[test]
    fn nothing_but_a_dead_trial_stops_a_session_starting() {
        for s in [
            Status::Active,
            Status::UpdateRequired,
            Status::CheckInRequired,
            Status::WrongMachine,
            Status::Invalid,
        ] {
            assert!(!s.blocks_new_session(), "{s:?} must not stop the console opening");
        }
        assert!(Status::Expired.blocks_new_session());
    }

    #[test]
    fn a_token_for_another_machine_is_not_a_licence_for_this_one() {
        let v = check(VALID, "0000000000000000ffffffffffffffff", IN_WINDOW, NOW, PUBKEY, PRODUCT);
        assert_eq!(v.status, Status::WrongMachine);
        // the claims are readable — the panel needs them to offer re-activation
        assert_eq!(v.claims.expect("verified claims").key, "LT-V1ZZ-K7M2-9PQR-4XTC");
    }

    /// A licence minted for another of the vendor's products must not carry
    /// this one. The vectors are all `vizz`, which is exactly why the expected
    /// product is a parameter rather than a constant.
    #[test]
    fn a_token_for_another_product_is_invalid_here() {
        assert_eq!(check(VALID, MACHINE, IN_WINDOW, NOW, PUBKEY, "light").status, Status::Invalid);
    }

    /// The exact boundary, pinned because the vendor's vectors do not cover it
    /// and their SDK is the only statement of it.
    #[test]
    fn the_lease_lapses_at_exp_not_after_it() {
        // VALID has exp = 1762592000
        assert_eq!(status_of(VALID, IN_WINDOW, 1_762_591_999), Status::Active);
        assert_eq!(status_of(VALID, IN_WINDOW, 1_762_592_000), Status::CheckInRequired);
    }

    /// The placeholder the integration page currently serves must never read as
    /// a licence. This is the state every build ships in until the signing key
    /// is configured on the deployment.
    #[test]
    fn an_unconfigured_public_key_verifies_nothing() {
        for key in ["", "REPLACE_WITH_YOUR_PUBLIC_KEY_HEX", "00", &"aa".repeat(32)] {
            assert_eq!(
                check(VALID, MACHINE, IN_WINDOW, NOW, key, PRODUCT).status,
                Status::Invalid,
                "key {key:?} accepted a token"
            );
        }
    }

    #[test]
    fn malformed_shapes_are_rejected_rather_than_guessed() {
        for bad in ["", ".", "a.", ".b", "a.b.c", "not-base64!.also-not", "eyJ2IjoxfQ"] {
            assert_eq!(status_of(bad, IN_WINDOW, NOW), Status::Invalid, "accepted {bad:?}");
        }
    }
}
