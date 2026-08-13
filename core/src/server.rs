use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::protocol::Role;
use tungstenite::{Message, WebSocket};

use crate::engine::EngineMsg;
use crate::types::Command;

pub type ClientId = u64;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Fan-out of engine events to every connected WS client.
#[derive(Clone)]
pub struct Broadcaster {
    clients: Arc<Mutex<HashMap<ClientId, std::sync::mpsc::Sender<String>>>>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster { clients: Arc::new(Mutex::new(HashMap::new())) }
    }
    pub fn broadcast(&self, msg: &str) {
        let mut m = self.clients.lock().unwrap();
        m.retain(|_, tx| tx.send(msg.to_string()).is_ok());
    }
    pub fn send_to(&self, id: ClientId, msg: String) {
        if let Some(tx) = self.clients.lock().unwrap().get(&id) {
            let _ = tx.send(msg);
        }
    }
    pub fn count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }
    fn add(&self, id: ClientId, tx: std::sync::mpsc::Sender<String>) {
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
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let tx = tx.clone();
            let bc = bc.clone();
            let dist = dist.clone();
            std::thread::spawn(move || {
                let _ = handle_conn(stream, dist, tx, bc);
            });
        }
    });
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
    let reader_stream = stream.try_clone()?;
    reader_stream.set_read_timeout(None).ok();
    let mut ws_read = match tungstenite::accept(reader_stream) {
        Ok(ws) => ws,
        Err(_) => return Ok(()),
    };
    let writer_stream = stream;
    writer_stream.set_read_timeout(None).ok();
    let mut ws_write: WebSocket<TcpStream> =
        WebSocket::from_raw_socket(writer_stream, Role::Server, None);

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (out_tx, out_rx) = std::sync::mpsc::channel::<String>();
    bc.add(id, out_tx);
    let _ = tx.send(EngineMsg::ClientConnected(id));

    // Writer: its channel sender lives in the broadcaster map; when the client
    // is removed the sender drops and this thread ends.
    std::thread::spawn(move || {
        while let Ok(s) = out_rx.recv() {
            if ws_write.send(Message::Text(s)).is_err() {
                break;
            }
        }
        let _ = ws_write.close(None);
    });

    // Reader: commands to the engine.
    loop {
        match ws_read.read() {
            Ok(Message::Text(t)) => {
                if let Ok(cmd) = serde_json::from_str::<Command>(&t) {
                    let _ = tx.send(EngineMsg::Cmd(cmd));
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    bc.remove(id);
    let _ = tx.send(EngineMsg::ClientDisconnected);
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
