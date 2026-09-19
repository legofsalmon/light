use std::collections::HashMap;
use std::net::UdpSocket;
use std::net::Ipv4Addr;
use std::time::Instant;

use crate::send_health::SendHealth;

const SACN_PORT: u16 = 5568;
/// How often, at most, to rebuild a refused send socket.
const REBIND_EVERY: std::time::Duration = std::time::Duration::from_secs(2);
const PACKET_LEN: usize = 638;

/// sACN (E1.31) sender — root/framing/DMP layers with start code 0, multicast
/// to 239.255.hi.lo unless a unicast address is configured.
pub struct SacnOut {
    sock: Option<UdpSocket>,
    cid: [u8; 16],
    seq: HashMap<u16, u8>,
    source_name: String,
    pub packets: u64,
    /// whether the OS is taking our packets — see send_health.rs
    health: SendHealth,
    /// last time we rebuilt the send socket to recover from a refusal
    last_rebind: Option<Instant>,
    /// the adapter the operator chose (None = automatic) — see netif.rs
    iface: Option<String>,
    /// the address the current socket is bound to (None = any)
    bound: Option<Ipv4Addr>,
    last_reconcile: Option<Instant>,
}

impl SacnOut {
    /// A fresh multicast-capable send socket on the given adapter address
    /// (any, when None), or the error that stopped it.
    fn open_socket(bind: Option<Ipv4Addr>) -> std::io::Result<UdpSocket> {
        let s = UdpSocket::bind((bind.unwrap_or(Ipv4Addr::UNSPECIFIED), 0))?;
        s.set_multicast_ttl_v4(4).ok();
        // a socket bound to an adapter's address sends its multicast on that
        // adapter too — no separate interface option needed
        s.set_nonblocking(true)?;
        Ok(s)
    }

    pub fn new() -> Self {
        let mut health = SendHealth::default();
        let sock = Self::open_socket(None)
            .map_err(|e| {
                eprintln!("[sacn] socket error: {e}");
                health.note_permanent(format!("no socket: {e}"));
            })
            .ok();
        let mut cid = [0u8; 16];
        let _ = getrandom::getrandom(&mut cid);
        SacnOut { sock, cid, seq: HashMap::new(), source_name: "LIGHT look engine".into(), packets: 0, health, last_rebind: None, iface: None, bound: None, last_reconcile: None }
    }

    /// Rebuild the send socket on whatever the chosen adapter resolves to now.
    fn rebind(&mut self, why: &str) {
        let want = crate::netif::resolve(self.iface.as_deref());
        match Self::open_socket(want) {
            Ok(s) => {
                eprintln!(
                    "[sacn] send socket rebuilt ({why}) on {}",
                    want.map_or("any adapter".to_string(), |ip| ip.to_string())
                );
                self.sock = Some(s);
                self.bound = want;
            }
            Err(e) => self.health.note_permanent(format!("no socket: {e}")),
        }
    }

    /// Choose the adapter to send from (None = automatic) — see artnet.rs.
    pub fn set_interface(&mut self, name: Option<&str>) {
        if self.iface.as_deref() == name {
            return;
        }
        self.iface = name.map(str::to_string);
        self.rebind("adapter chosen");
    }

    /// The auto pick-up — see artnet.rs.
    pub fn reconcile_interface(&mut self, now: Instant) {
        if self.iface.is_none() {
            return;
        }
        if self.last_reconcile.is_some_and(|t| now.duration_since(t) < std::time::Duration::from_secs(3)) {
            return;
        }
        self.last_reconcile = Some(now);
        let want = crate::netif::resolve(self.iface.as_deref());
        if want != self.bound {
            self.rebind("adapter changed");
        }
    }

    /// Rebuild the send socket when the OS is refusing our packets — the same
    /// macOS Local Network recovery as the Art-Net sender (see artnet.rs).
    pub fn recover_if_failing(&mut self, now: Instant) {
        if self.health.current(now).is_none() {
            return;
        }
        if self.last_rebind.is_some_and(|t| now.duration_since(t) < REBIND_EVERY) {
            return;
        }
        self.last_rebind = Some(now);
        self.rebind("refused send");
    }

    pub fn send(&mut self, universe: u16, data: &[u8; 512], unicast: Option<&str>) {
        let Some(sock) = &self.sock else { return };
        if universe < 1 || universe > 63999 {
            return;
        }
        let seq = self.seq.entry(universe).or_insert(0);
        *seq = seq.wrapping_add(1);

        let mut p = [0u8; PACKET_LEN];
        // root layer
        p[0..2].copy_from_slice(&0x0010u16.to_be_bytes());
        p[2..4].copy_from_slice(&0x0000u16.to_be_bytes());
        p[4..16].copy_from_slice(b"ASC-E1.17\0\0\0");
        p[16..18].copy_from_slice(&(0x7000u16 | (PACKET_LEN as u16 - 16)).to_be_bytes());
        p[18..22].copy_from_slice(&0x0000_0004u32.to_be_bytes());
        p[22..38].copy_from_slice(&self.cid);
        // framing layer
        p[38..40].copy_from_slice(&(0x7000u16 | (PACKET_LEN as u16 - 38)).to_be_bytes());
        p[40..44].copy_from_slice(&0x0000_0002u32.to_be_bytes());
        let name = self.source_name.as_bytes();
        let n = name.len().min(63);
        p[44..44 + n].copy_from_slice(&name[..n]);
        p[108] = 100; // priority
        p[109..111].copy_from_slice(&0u16.to_be_bytes()); // sync address
        p[111] = *seq;
        p[112] = 0; // options
        p[113..115].copy_from_slice(&universe.to_be_bytes());
        // DMP layer
        p[115..117].copy_from_slice(&(0x7000u16 | (PACKET_LEN as u16 - 115)).to_be_bytes());
        p[117] = 0x02;
        p[118] = 0xa1;
        p[119..121].copy_from_slice(&0u16.to_be_bytes());
        p[121..123].copy_from_slice(&1u16.to_be_bytes());
        p[123..125].copy_from_slice(&513u16.to_be_bytes());
        p[125] = 0; // start code
        p[126..].copy_from_slice(data);

        let dest: std::net::Ipv4Addr = match unicast.and_then(|s| s.parse().ok()) {
            Some(ip) => ip,
            None => std::net::Ipv4Addr::new(239, 255, ((universe >> 8) & 0xff) as u8, (universe & 0xff) as u8),
        };
        match sock.send_to(&p, (dest, SACN_PORT)) {
            Ok(_) => self.packets += 1,
            Err(e) => self.health.note_err(format!("{dest}: {e}"), Instant::now()),
        }
    }

    /// The OS error from a send refused within the last second, if any.
    pub fn send_error(&self) -> Option<String> {
        self.health.current(Instant::now()).map(str::to_string)
    }
}
