use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const ARTNET_PORT: u16 = 6454;

#[derive(Clone)]
pub struct DiscoveredNode {
    pub ip: String,
    pub name: String,
    pub last_seen: Instant,
}

enum PollState {
    Off,
    On,
    Failed,
}

/// Art-Net ArtDmx sender. Packet layout identical to the Node reference:
/// "Art-Net\0" | OpDmx 0x5000 LE | ProtVer 14 BE | Seq | Phys | SubUni | Net |
/// Length BE | 512 data bytes.
pub struct ArtnetOut {
    sock: Option<UdpSocket>,
    seq: HashMap<u16, u8>,
    pub packets: u64,
    nodes: Arc<Mutex<HashMap<String, DiscoveredNode>>>,
    poll_state: PollState,
    last_poll: Option<Instant>,
}

impl ArtnetOut {
    pub fn new() -> Self {
        let sock = UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| {
                s.set_broadcast(true)?;
                s.set_nonblocking(true)?;
                Ok(s)
            })
            .map_err(|e| eprintln!("[artnet] socket error: {e}"))
            .ok();
        ArtnetOut {
            sock,
            seq: HashMap::new(),
            packets: 0,
            nodes: Arc::new(Mutex::new(HashMap::new())),
            poll_state: PollState::Off,
            last_poll: None,
        }
    }

    /// Send an ArtPoll every ~3 s while any universe outputs Art-Net, and
    /// lazily start the reply listener. Discovery answers the first question
    /// at every gig — "is the node even receiving?" — so its health is
    /// surfaced, never assumed. Mirror of the Node reference.
    pub fn poll_tick(&mut self, enabled: bool, unicasts: &[Option<String>]) {
        // LIGHT_NO_ARTPOLL: test harnesses must never bind 6454 or broadcast
        // polls onto a real LAN (an MVR import can re-enable artnet mid-run)
        if !enabled || std::env::var("LIGHT_NO_ARTPOLL").is_ok() {
            return;
        }
        if matches!(self.poll_state, PollState::Off) {
            self.open_poll_listener();
        }
        if !matches!(self.poll_state, PollState::On) {
            return;
        }
        if self
            .last_poll
            .is_some_and(|t| t.elapsed() < Duration::from_secs(3))
        {
            return;
        }
        self.last_poll = Some(Instant::now());
        // prune here too — the node map must not grow without a UI attached
        if let Ok(mut map) = self.nodes.lock() {
            map.retain(|_, n| n.last_seen.elapsed() < Duration::from_secs(30));
        }
        let Some(sock) = &self.sock else { return };
        let mut pkt = [0u8; 14];
        pkt[..8].copy_from_slice(b"Art-Net\0");
        pkt[8..10].copy_from_slice(&0x2000u16.to_le_bytes()); // OpPoll
        pkt[10..12].copy_from_slice(&14u16.to_be_bytes());
        // TalkToMe 0, priority 0
        let _ = sock.send_to(&pkt, (std::net::Ipv4Addr::BROADCAST, ARTNET_PORT));
        // routed/unicast rigs never hear a local broadcast — poll directly
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for u in unicasts.iter().flatten() {
            if !seen.insert(u.as_str()) {
                continue;
            }
            if let Ok(ip) = u.parse::<std::net::Ipv4Addr>() {
                let _ = sock.send_to(&pkt, (ip, ARTNET_PORT));
            }
        }
    }

    pub fn poll_status(&self) -> &'static str {
        match self.poll_state {
            PollState::Off => "off",
            PollState::On => "on",
            PollState::Failed => "failed",
        }
    }

    fn open_poll_listener(&mut self) {
        // exclusive bind: if other lighting software holds 6454 we degrade
        // to "unknown" — the status dot explains, and we never retry-loop
        match UdpSocket::bind(("0.0.0.0", ARTNET_PORT)) {
            Ok(listener) => {
                let _ = listener.set_read_timeout(Some(Duration::from_millis(1000)));
                let nodes = Arc::clone(&self.nodes);
                std::thread::spawn(move || {
                    let mut buf = [0u8; 1024];
                    loop {
                        let Ok((len, from)) = listener.recv_from(&mut buf) else {
                            continue; // timeout — keep listening
                        };
                        if len < 44 || &buf[..8] != b"Art-Net\0" {
                            continue;
                        }
                        let op = u16::from_le_bytes([buf[8], buf[9]]);
                        if op != 0x2100 {
                            continue; // OpPollReply only
                        }
                        let raw = &buf[26..44];
                        let name_end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
                        let name = String::from_utf8_lossy(&raw[..name_end]).trim().to_string();
                        let ip = from.ip().to_string();
                        let display = if name.is_empty() { ip.clone() } else { name };
                        if let Ok(mut map) = nodes.lock() {
                            map.insert(
                                ip.clone(),
                                DiscoveredNode { ip, name: display, last_seen: Instant::now() },
                            );
                        }
                    }
                });
                self.poll_state = PollState::On;
            }
            Err(e) => {
                eprintln!("[artnet] poll listener unavailable: {e}");
                self.poll_state = PollState::Failed;
            }
        }
    }

    /// Fresh node list for the snapshot; entries silent > 30 s are dropped.
    pub fn nodes_snapshot(&self) -> Vec<crate::types::ArtnetNodeSnap> {
        let Ok(mut map) = self.nodes.lock() else { return Vec::new() };
        map.retain(|_, n| n.last_seen.elapsed() < Duration::from_secs(30));
        let mut out: Vec<crate::types::ArtnetNodeSnap> = map
            .values()
            .map(|n| crate::types::ArtnetNodeSnap {
                ip: n.ip.clone(),
                name: n.name.clone(),
                age_ms: n.last_seen.elapsed().as_millis() as u64,
            })
            .collect();
        out.sort_by(|a, b| a.ip.cmp(&b.ip));
        out.truncate(8);
        out
    }

    pub fn send(&mut self, universe: u16, data: &[u8; 512], unicast: Option<&str>) {
        let Some(sock) = &self.sock else { return };
        let u = universe & 0x7fff;
        let seq = self.seq.entry(u).or_insert(0);
        *seq = if *seq >= 255 { 1 } else { *seq + 1 };

        let mut pkt = [0u8; 530];
        pkt[..8].copy_from_slice(b"Art-Net\0");
        pkt[8..10].copy_from_slice(&0x5000u16.to_le_bytes());
        pkt[10..12].copy_from_slice(&14u16.to_be_bytes());
        pkt[12] = *seq;
        pkt[13] = 0;
        pkt[14] = (u & 0xff) as u8;
        pkt[15] = ((u >> 8) & 0x7f) as u8;
        pkt[16..18].copy_from_slice(&512u16.to_be_bytes());
        pkt[18..].copy_from_slice(data);

        // IP literals only — hostnames would resolve via DNS on the 40 Hz
        // output path. Invalid strings fall back to broadcast so the rig
        // keeps receiving while an address is being typed.
        let dest: std::net::Ipv4Addr = unicast
            .and_then(|s| s.parse().ok())
            .unwrap_or(std::net::Ipv4Addr::BROADCAST);
        if sock.send_to(&pkt, (dest, ARTNET_PORT)).is_ok() {
            self.packets += 1;
        }
    }
}
