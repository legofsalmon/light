# Licensing — LeTissier integration plan

Groundwork for wiring <https://letissier.ie/integrate> into LIGHT. **Nothing is
implemented yet**, deliberately: the two blockers at the bottom mean a verifier
written today could be neither compiled nor tested, and a licence check that has
never run is not something to put in a console that drives a show.

Everything below was read off the service's own documentation and one of its
published test vectors, not from memory.

## The shape of it

A licence is an **Ed25519-signed token**, `base64url(payload).base64url(signature)`,
cached on disk and checked offline. The network is only for getting a fresh
token; it is never in the path of the app starting or the rig lighting.

Decoded from a published test vector, the payload is exactly:

```json
{
  "v": 1,
  "key": "LT-V1ZZ-K7M2-9PQR-4XTC",
  "product": "vizz",
  "edition": "standard",
  "customer": "11111111-2222-3333-4444-555555555555",
  "name": "Test Buyer",
  "seats": 2,
  "maintUntil": 1791536000,
  "exp": 1762592000,
  "machine": "8b9dd6da2bcf47bdfe7ceb27c2a58680",
  "mode": "online",
  "iat": 1760000000,
  "jti": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
}
```

`product` for us is `light`. `machine` is the first 32 hex characters of
SHA-256 over the trimmed machine fingerprint.

**The two dates mean different things and must not be confused:**

| Field | Meaning |
|---|---|
| `maintUntil` | the update entitlement window. A build released *before* this runs forever — this is why the build's own timestamp has to be compiled in rather than read off the filesystem. |
| `exp` | the lease check-in deadline (30 days by default). Passing it does **not** end the licence; it asks for a heartbeat. |

## Endpoints

All `POST` under `https://letissier.ie`:

| Path | Body |
|---|---|
| `/api/licence/activate` | `{ key, machine, label }` |
| `/api/licence/heartbeat` | `{ key, machine }` |
| `/api/licence/deactivate` | `{ key, machine }` |
| `/api/licence/trial` | `{ product, email, machine, name }` |

Heartbeat cadence is roughly daily. The service's own guidance is that network
failure falls back to the cached token and must not block startup.

## Statuses, and what LIGHT should do

The service defines six. The right-hand column is what they should mean *here* —
this is a lighting console, and the governing rule is that **no licence state
ever stops DMX going out or a cue firing mid-show.**

| Status | Service's intent | LIGHT's behaviour |
|---|---|---|
| `active` | run normally | run normally |
| `update_required` | run the entitled build, or offer renewal — explicitly *not* piracy | banner in the top bar; nothing restricted |
| `check_in_required` | heartbeat, grace period before restricting | heartbeat quietly; banner only after the grace window; never mid-show |
| `expired` | prompt to purchase | banner and a purchase route; **still runs the rig** |
| `wrong_machine` | re-activate | banner offering activation on this machine |
| `invalid` | treat as unlicensed | banner; treat as unlicensed, still runs the rig |

Two non-negotiables for this app:

1. **The engine core stays out of it.** `light-core` drives DMX at 40 Hz, is
   parity-locked against the Node reference, and also runs headless serving a
   LAN tablet. Licensing belongs in `src-tauri` (the desktop shell), which
   already carries `reqwest` and the Keychain. Putting it in the core would mean
   a Node twin of a licence checker for no reason, and would put a network
   concern next to the tick loop that `ROADMAP.md` forbids.
2. **The token is not project data.** It goes beside the projects, or in the
   Keychain — never into the project JSON, which is broadcast whole to every
   connected client including the tablet (the same rule the GDTF Share
   credentials follow; see `parked-work.md` §2).

## Implementation sketch

- `src-tauri/src/licence.rs` — pure and testable: claim model, token split,
  signature verification, and the status decision as a function of
  `(claims, build_timestamp, now, this machine's hash)`. No I/O.
- Signature verification via **`ring::signature::ED25519`**. `ring 0.17.14` is
  already in `Cargo.lock` and the local registry cache — the TLS stack `reqwest`
  pulls carries it — so this needs no new third-party crypto in a show console
  and no hand-rolled curve25519. `base64` and `sha2` are likewise already
  present in the tree.
- `src-tauri/build.rs` — stamp the build's Unix time into an env var at compile
  time. Integration step 3 is explicit that this must not come from the
  filesystem, and it is what makes `maintUntil` mean "builds from before this
  date keep working".
- Network calls in a separate module, off the startup path, with the cached
  token as the answer whenever the network is unavailable.
- UI: a licence panel (Output tab or an About surface) showing status, machine,
  seats and the two dates, plus activation and deactivation. The operator types
  their own licence key — the app never invents or stores one anywhere but the
  Keychain.

Tests should not need the network: `ring` can generate a keypair and sign, so a
test can mint a token, assert it verifies, then assert that a flipped byte in
the payload, a foreign machine hash, and a lapsed `exp` each land on the right
status.

## The two blockers

1. **The production public key is a placeholder.** The integration page ships
   `REPLACE_WITH_YOUR_PUBLIC_KEY_HEX`; the only real key published is the *test*
   key in `vectors.json` (SPKI base64
   `MCowBQYDK2VwAyEAZG93X11sthQjCXcHvKEW4/XE0jxDzaLy2ZOKHFPtQYA=`). The real one
   is account-specific and has to come from the LeTissier account holder.
2. **What the signature actually covers is not documented.** The token is
   `payload.signature`, but nothing states whether Ed25519 signs the *raw
   decoded payload bytes* or the *ASCII of the base64url payload segment*. The
   vectors would settle it in one run; treat it as a single constant in the
   verifier with a test pinning it, and check it against
   `/integrate/vectors.json` before shipping. Do not "accept either" — a
   verifier with two acceptance paths is a weaker verifier.

Both are one-line unblocks. Until then this file is the whole design, and no
half-verifier is in the tree: an unverifiable signature check that defaults to
"licensed" is a decoration, and one that defaults to "unlicensed" would be a
console that refuses to work.

## Note on how this was gathered

The vendor's SDKs (Rust, C++, Python, TypeScript at `/integrate/sdk/{lang}/`)
could not be retrieved in the session that wrote this. That is no loss: the
protocol is small and writing the client against the documented wire format —
rather than vendoring unreviewed third-party code into the process that drives
the rig — is the better trade here anyway. Read the SDK if you like, but review
it before it goes near the tick thread.
