use std::collections::HashMap;
use std::net::UdpSocket;

const ARTNET_PORT: u16 = 6454;

/// Art-Net ArtDmx sender. Packet layout identical to the Node reference:
/// "Art-Net\0" | OpDmx 0x5000 LE | ProtVer 14 BE | Seq | Phys | SubUni | Net |
/// Length BE | 512 data bytes.
pub struct ArtnetOut {
    sock: Option<UdpSocket>,
    seq: HashMap<u16, u8>,
    pub packets: u64,
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
        ArtnetOut { sock, seq: HashMap::new(), packets: 0 }
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
