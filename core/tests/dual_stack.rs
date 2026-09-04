//! The server must answer on IPv4 *and* IPv6.
//!
//! Regression test for the bug that shipped in v1.1.0 through v1.2.1: the v6
//! wildcard was bound as a guard against a second engine, but never accepted
//! on. macOS resolves `localhost` to ::1 first, and the app window loads
//! tauri://localhost — so wsUrl() dialled ws://localhost:9900, landed on the
//! guard socket, completed the TCP handshake, and waited forever for a reply.
//! The engine was healthy throughout; the UI just said it was not responding.
//!
//! A hung connection is worse than a refused one: ECONNREFUSED would have sent
//! the browser to IPv4 in milliseconds. So this asserts a real response on both
//! families, not merely that something is listening.

#![cfg(feature = "engine")]

use light_core::engine::EngineMsg;
use light_core::server::{start, Broadcaster};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// Send a bare HTTP request and return the status line, or None if the peer
/// never answered. Short timeouts: a pass is milliseconds, a regression hangs.
fn head(addr: SocketAddr) -> Option<String> {
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    // The old guard socket accepted the connection and read nothing, so the
    // write below succeeds there too — only the read distinguishes them.
    s.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut buf = [0u8; 256];
    let n = s.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n]).lines().next()?.to_string())
}

#[test]
fn serves_both_ip_families() {
    // A port well clear of 9900 so a running engine or app cannot mask this.
    let port = 9987;
    let (tx, _rx) = std::sync::mpsc::channel::<EngineMsg>();
    start(port, None, tx, Broadcaster::new()).expect("server must bind");
    std::thread::sleep(Duration::from_millis(200));

    let v4 = head(SocketAddr::from(([127, 0, 0, 1], port)));
    assert!(
        v4.as_deref().is_some_and(|l| l.starts_with("HTTP/1.1")),
        "IPv4 must answer, got {v4:?}"
    );

    // The one that regressed — where the host can serve it at all.
    //
    // `start` takes the v4 wildcard first and then tries `::` best-effort. On
    // macOS IPV6_V6ONLY defaults on, so `::` is a separate socket and binds:
    // that is the case this test exists for, because `localhost` resolves to
    // ::1 first and the app window dials it. On Linux `::` is dual-stack and
    // collides with the v4 wildcard already held, so the bind returns None and
    // NOTHING serves ::1 — server.rs says exactly this and calls it
    // best-effort.
    //
    // So this assertion is a macOS guarantee, not a universal one. It asserted
    // it universally, failed on every Linux CI run from 2026-08-19, and — worse
    // than a red test — the parity step sits behind it in ci.yml, so main went
    // six weeks with no differential parity coverage at all.
    //
    // An earlier attempt at this skipped when `[::1]:0` could not be bound.
    // That was the wrong probe and it never fired: the runner has IPv6 loopback
    // perfectly well. The question is not whether the host HAS v6, it is
    // whether `::` can be taken while the v4 wildcard is held — which is
    // precisely what `start` does, so probe that.
    let collides = {
        let scratch = TcpListener::bind(("0.0.0.0", 0)).expect("a scratch v4 port");
        let p = scratch.local_addr().expect("addr").port();
        TcpListener::bind(("::", p)).is_err()
    };
    if collides {
        eprintln!(
            "SKIPPED the IPv6 half: on this host `::` collides with the v4 wildcard, so \
             server.rs cannot take it and ::1 is served by nothing. The IPv4 half ran."
        );
        return;
    }

    let v6 = head(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)));
    assert!(
        v6.as_deref().is_some_and(|l| l.starts_with("HTTP/1.1")),
        "IPv6 (::1) must answer — this is what ws://localhost dials, got {v6:?}"
    );
}
