use std::collections::HashMap;
use std::net::UdpSocket;

const SACN_PORT: u16 = 5568;
const PACKET_LEN: usize = 638;

/// sACN (E1.31) sender — root/framing/DMP layers with start code 0, multicast
/// to 239.255.hi.lo unless a unicast address is configured.
pub struct SacnOut {
    sock: Option<UdpSocket>,
    cid: [u8; 16],
    seq: HashMap<u16, u8>,
    source_name: String,
    pub packets: u64,
}

impl SacnOut {
    pub fn new() -> Self {
        let sock = UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| {
                s.set_multicast_ttl_v4(4).ok();
                s.set_nonblocking(true)?;
                Ok(s)
            })
            .map_err(|e| eprintln!("[sacn] socket error: {e}"))
            .ok();
        let mut cid = [0u8; 16];
        let _ = getrandom::getrandom(&mut cid);
        SacnOut { sock, cid, seq: HashMap::new(), source_name: "LIGHT look engine".into(), packets: 0 }
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
        if sock.send_to(&p, (dest, SACN_PORT)).is_ok() {
            self.packets += 1;
        }
    }
}
