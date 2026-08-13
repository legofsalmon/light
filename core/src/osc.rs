use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct OscMessage {
    pub addr: String,
    pub args: Vec<serde_json::Value>,
}

fn read_padded_string(buf: &[u8], offset: usize) -> Option<(String, usize)> {
    if offset >= buf.len() {
        return None;
    }
    let mut end = offset;
    while end < buf.len() && buf[end] != 0 {
        end += 1;
    }
    let s = String::from_utf8_lossy(&buf[offset..end]).to_string();
    let next = offset + ((end - offset) / 4 + 1) * 4;
    Some((s, next))
}

fn be_f32(buf: &[u8], o: usize) -> Option<f64> {
    Some(f32::from_be_bytes(buf.get(o..o + 4)?.try_into().ok()?) as f64)
}
fn be_i32(buf: &[u8], o: usize) -> Option<i64> {
    Some(i32::from_be_bytes(buf.get(o..o + 4)?.try_into().ok()?) as i64)
}

/// Parse one OSC packet (message or #bundle) into flat messages.
pub fn parse_osc(buf: &[u8]) -> Vec<OscMessage> {
    if buf.len() < 4 {
        return vec![];
    }
    if buf.starts_with(b"#bundle") {
        let mut out = Vec::new();
        let mut o = 16usize;
        while o + 4 <= buf.len() {
            let size = u32::from_be_bytes(buf[o..o + 4].try_into().unwrap()) as usize;
            o += 4;
            if size == 0 || o + size > buf.len() {
                break;
            }
            out.extend(parse_osc(&buf[o..o + size]));
            o += size;
        }
        return out;
    }
    let Some((addr, mut o)) = read_padded_string(buf, 0) else { return vec![] };
    if !addr.starts_with('/') {
        return vec![];
    }
    let mut tags = String::new();
    if o < buf.len() && buf[o] == b',' {
        let Some((t, next)) = read_padded_string(buf, o) else {
            return vec![OscMessage { addr, args: vec![] }];
        };
        tags = t[1..].to_string();
        o = next;
    }
    let mut args: Vec<serde_json::Value> = Vec::new();
    for t in tags.chars() {
        match t {
            'f' => {
                let Some(v) = be_f32(buf, o) else { break };
                args.push(serde_json::json!(v));
                o += 4;
            }
            'i' => {
                let Some(v) = be_i32(buf, o) else { break };
                args.push(serde_json::json!(v));
                o += 4;
            }
            'd' => {
                let Some(b) = buf.get(o..o + 8) else { break };
                args.push(serde_json::json!(f64::from_be_bytes(b.try_into().unwrap())));
                o += 8;
            }
            'h' => {
                let Some(b) = buf.get(o..o + 8) else { break };
                args.push(serde_json::json!(i64::from_be_bytes(b.try_into().unwrap())));
                o += 8;
            }
            's' | 'S' => {
                let Some((s, next)) = read_padded_string(buf, o) else { break };
                args.push(serde_json::json!(s));
                o = next;
            }
            'b' => {
                let Some(len) = be_i32(buf, o) else { break };
                if len < 0 {
                    break; // negative blob length would overflow usize
                }
                o += 4 + ((len as usize + 3) / 4) * 4;
            }
            'T' => args.push(serde_json::json!(1)),
            'F' => args.push(serde_json::json!(0)),
            'N' => {}
            _ => break,
        }
    }
    vec![OscMessage { addr, args }]
}

/// UDP OSC listener thread with hot rebind when the port/enabled state changes.
pub struct OscIn {
    stop: Option<Arc<AtomicBool>>,
    alive: Option<Arc<AtomicBool>>,
    current: Option<u16>,
}

impl OscIn {
    pub fn new() -> Self {
        OscIn { stop: None, alive: None, current: None }
    }

    pub fn listen<F: Fn(OscMessage) + Send + 'static>(&mut self, port: u16, enabled: bool, on_msg: F) {
        if !enabled {
            self.stop();
            return;
        }
        // A dead listener (bind failure, thread exit) must not be mistaken
        // for a live one — re-attempt whenever it isn't provably running.
        let running = self.alive.as_ref().map(|a| a.load(Ordering::Relaxed)).unwrap_or(false);
        if self.current == Some(port) && running {
            return;
        }
        self.stop();
        // Bind synchronously so failure is visible immediately and the next
        // project change retries.
        let sock = match UdpSocket::bind(("0.0.0.0", port)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[osc] listen error on :{port}: {e} (will retry on next change)");
                self.current = None;
                return;
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let alive2 = alive.clone();
        self.stop = Some(stop);
        self.alive = Some(alive);
        self.current = Some(port);
        std::thread::spawn(move || {
            sock.set_read_timeout(Some(Duration::from_millis(400))).ok();
            let mut buf = [0u8; 4096];
            while !stop2.load(Ordering::Relaxed) {
                match sock.recv_from(&mut buf) {
                    Ok((n, _)) => {
                        for msg in parse_osc(&buf[..n]) {
                            on_msg(msg);
                        }
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => break,
                }
            }
            alive2.store(false, Ordering::Relaxed);
        });
    }

    pub fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            s.store(true, Ordering::Relaxed);
        }
        self.alive = None;
        self.current = None;
    }
}
