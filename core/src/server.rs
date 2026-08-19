use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::Message;

use crate::engine::EngineMsg;
use crate::types::Command;

pub type ClientId = u64;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Fan-out of engine events to every connected WS client. Queues are
/// bounded: a client that falls a full queue behind (~25 s of snapshots) is
/// dead and gets evicted rather than buffering unbounded backlog.
#[derive(Clone)]
pub struct Broadcaster {
    clients: Arc<Mutex<HashMap<ClientId, std::sync::mpsc::SyncSender<String>>>>,
    /// Clients that had a frame dropped because their queue was full.
    missed: Arc<Mutex<std::collections::HashSet<ClientId>>>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster {
            clients: Arc::new(Mutex::new(HashMap::new())),
            missed: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    /// Clients that were too backed up to take a frame, cleared as it is read.
    ///
    /// Skipping a frame for a stalled client is right for snapshots — they are
    /// disposable — but the SAME path carries the authoritative whole-project
    /// echo. Dropping that silently leaves the client holding a stale show, and
    /// the next thing it sends is that stale project, applied wholesale to the
    /// rig. Eviction used to be the resync (via reconnect); nothing replaced it,
    /// so this does.
    pub fn take_missed(&self) -> Vec<ClientId> {
        let mut m = self.missed.lock().unwrap();
        m.drain().collect()
    }

    pub fn has_missed(&self) -> bool {
        !self.missed.lock().unwrap().is_empty()
    }
    pub fn broadcast(&self, msg: &str) {
        let mut m = self.clients.lock().unwrap();
        let mut missed = self.missed.lock().unwrap();
        m.retain(|id, tx| match tx.try_send(msg.to_string()) {
            Ok(()) => true,
            // A backed-up client is not a dead one. Snapshots are disposable, so
            // skip this frame and let it catch up — the queue is bounded, which
            // is all the backpressure this needs. Evicting instead dropped the
            // connection, and dropping a connection releases every flash that
            // client was holding: a blinder fading out mid-song because a
            // tablet's wifi hiccuped, and a reconnect under a new id so the
            // operator's eventual note-off could never match. Node has always
            // skipped rather than evicted (engine/server.ts), so this closes a
            // divergence as well as a stage failure.
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                missed.insert(*id);
                true
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
        });
    }
    /// Broadcast to everyone except one client — used for the project echo
    /// when every change since the last one came from that client. It already
    /// has this state; sending it back lands on top of whatever the operator
    /// has dragged or typed in the meantime and silently discards it.
    pub fn broadcast_except(&self, skip: ClientId, msg: &str) {
        let mut m = self.clients.lock().unwrap();
        m.retain(|id, tx| {
            if *id == skip {
                return true;
            }
            match tx.try_send(msg.to_string()) {
                Ok(()) => true,
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    self.missed.lock().unwrap().insert(*id);
                    true
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
            }
        });
    }
    pub fn send_to(&self, id: ClientId, msg: String) {
        if let Some(tx) = self.clients.lock().unwrap().get(&id) {
            // still backed up: keep it marked so the resend is retried
            if let Err(std::sync::mpsc::TrySendError::Full(_)) = tx.try_send(msg) {
                self.missed.lock().unwrap().insert(id);
            }
        }
    }
    pub fn count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }
    fn add(&self, id: ClientId, tx: std::sync::mpsc::SyncSender<String>) {
        self.clients.lock().unwrap().insert(id, tx);
    }
    fn remove(&self, id: ClientId) {
        self.clients.lock().unwrap().remove(&id);
    }
}

/// HTTP (static UI) + WebSocket server on one port, plain std threads.
pub fn start(
    port: u16,
    dist: Option<PathBuf>,
    tx: Sender<EngineMsg>,
    bc: Broadcaster,
) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    // Also take the v6 wildcard, and SERVE it — do not merely hold it.
    //
    // macOS defaults IPV6_V6ONLY on, so [::]:port is a separate socket from
    // the v4 wildcard above, and `localhost` resolves to ::1 *first*. This
    // socket was once bound and never accepted on, to stop a second engine
    // claiming it and driving the same rig. That guard worked, and cost us
    // the app: the window loads tauri://localhost, so wsUrl() dials
    // ws://localhost:9900, which lands on ::1, completes the TCP handshake
    // against a socket nobody accepts from, and waits forever. The engine is
    // healthy the whole time and the UI reports it as not responding.
    //
    // A black hole is worse than a closed port: refusing the connection would
    // have let the browser fall back to IPv4 in milliseconds. So answer on
    // both families. The second-engine guard is preserved — strengthened,
    // even, since the socket is now a real server rather than a decoy.
    //
    // Best-effort: on Linux `::` is dual-stack and therefore always collides
    // with the v4 wildcard we just took, leaving None here. A second engine
    // is still locked out, because it hits AddrInUse on v4 before reaching
    // this line. Node's http.listen(port) binds dual-stack and has always
    // served both — this brings the Rust core in line with it.
    let v6 = TcpListener::bind(("::", port)).ok();
    for l in std::iter::once(listener).chain(v6) {
        let tx = tx.clone();
        let bc = bc.clone();
        let dist = dist.clone();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let Ok(stream) = stream else { continue };
                let tx = tx.clone();
                let bc = bc.clone();
                let dist = dist.clone();
                std::thread::spawn(move || {
                    let _ = handle_conn(stream, dist, tx, bc);
                });
            }
        });
    }
    Ok(())
}

fn handle_conn(
    stream: TcpStream,
    dist: Option<PathBuf>,
    tx: Sender<EngineMsg>,
    bc: Broadcaster,
) -> std::io::Result<()> {
    stream.set_nodelay(true).ok();
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    // Peek until the full request head is visible (never consume — tungstenite
    // must see the handshake from the first byte).
    let mut buf = [0u8; 4096];
    let mut head = String::new();
    for _ in 0..40 {
        let n = stream.peek(&mut buf)?;
        head = String::from_utf8_lossy(&buf[..n]).to_string();
        if head.contains("\r\n\r\n") || n >= buf.len() {
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }

    let lower = head.to_lowercase();
    if lower.contains("upgrade:") && lower.contains("websocket") {
        handle_ws(stream, tx, bc)
    } else {
        handle_http(stream, &head, dist)
    }
}

fn handle_ws(stream: TcpStream, tx: Sender<EngineMsg>, bc: Broadcaster) -> std::io::Result<()> {
    // Handshake under the generous accept timeout set in handle_conn…
    let mut ws = match tungstenite::accept(stream) {
        Ok(ws) => ws,
        Err(_) => return Ok(()),
    };
    // …then a single thread owns the socket: short read timeout to poll,
    // write timeout to detect dead peers. One writer means ping replies and
    // broadcasts can never interleave into corrupted frames.
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(20))).ok();
    ws.get_ref().set_write_timeout(Some(Duration::from_secs(2))).ok();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (out_tx, out_rx) = std::sync::mpsc::sync_channel::<String>(512);
    bc.add(id, out_tx);
    let _ = tx.send(EngineMsg::ClientConnected(id));

    'conn: loop {
        // drain outbound
        loop {
            match out_rx.try_recv() {
                Ok(s) => match ws.send(Message::Text(s)) {
                    Ok(()) => {}
                    // A full kernel send buffer is not a dead peer. The read
                    // path below already tolerates exactly these two kinds; the
                    // write path treated them as fatal, so a few seconds of
                    // congestion cost the client its connection — and with it
                    // every flash it was holding. Stop draining this round and
                    // let the next pass resume: tungstenite keeps what it could
                    // not write and picks up at the right byte.
                    Err(tungstenite::Error::Io(ref e))
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        break
                    }
                    Err(_) => break 'conn,
                },
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'conn,
            }
        }
        // poll inbound
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Ok(cmd) = serde_json::from_str::<Command>(&t) {
                    let _ = tx.send(EngineMsg::Cmd(cmd, Some(id)));
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    let _ = ws.close(None);
    bc.remove(id);
    let _ = tx.send(EngineMsg::ClientDisconnected(id));
    Ok(())
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" | "map" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn handle_http(mut stream: TcpStream, head: &str, dist: Option<PathBuf>) -> std::io::Result<()> {
    // Consume the request bytes we previously only peeked.
    let mut sink = [0u8; 4096];
    let _ = stream.read(&mut sink);

    let path = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/");

    let respond = |stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8]| {
        let hdr = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(hdr.as_bytes())?;
        stream.write_all(body)
    };

    let Some(dist) = dist.filter(|d| d.exists()) else {
        return respond(
            &mut stream,
            "200 OK",
            "text/plain",
            b"LIGHT engine is running. Build the UI (npm run build) or use the dev server on :5173.",
        );
    };

    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    // Reject traversal and absolute paths — Path::join replaces the base when
    // handed an absolute path, which would escape the dist directory.
    if rel.contains("..") || rel.starts_with('/') || rel.contains('\\') || rel.contains(':') {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"forbidden");
    }
    let file = dist.join(rel);
    let target = if file.is_file() { file } else { dist.join("index.html") };
    match std::fs::read(&target) {
        Ok(body) => respond(
            &mut stream,
            "200 OK",
            mime_for(target.to_str().unwrap_or("")),
            &body,
        ),
        Err(_) => respond(&mut stream, "404 Not Found", "text/plain", b"not found"),
    }
}
