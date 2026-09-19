//! Which network adapter the rig lives on.
//!
//! A Mac at a gig is rarely on one network: a phone tethers, a VPN comes up, a
//! second adapter gets plugged in. With the send socket bound to "any
//! interface" the OS picks where a packet goes, and for a BROADCAST it picks
//! whichever interface holds the default route — one night that was the phone,
//! and every Art-Net frame left the laptop on the wrong wire while the app
//! read "live". Binding the socket to a chosen adapter makes every send,
//! broadcast or unicast, leave on that adapter whatever else is plugged in.
//!
//! The choice is by adapter NAME (`en7`), resolved to its current address each
//! time a socket is opened, so a DHCP renewal or a cable swap on the same
//! adapter is picked up by the senders' reconcile loop. An adapter that is
//! gone resolves to nothing and the senders fall back to "any" until it
//! returns — never silently dark, the snapshot says which happened.
//!
//! Twin of `engine/netif.ts`; `pick` carries the same tests on both sides.

use std::net::Ipv4Addr;

/// One usable adapter: up, IPv4, not loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adapter {
    pub name: String,
    pub ip: Ipv4Addr,
}

/// Every adapter a socket could be bound to, sorted by name, one address
/// each (the first IPv4 the OS lists for it).
pub fn adapters() -> Vec<Adapter> {
    let mut out: Vec<Adapter> = Vec::new();
    let Ok(addrs) = nix::ifaddrs::getifaddrs() else { return out };
    for ifa in addrs {
        let flags = ifa.flags;
        if !flags.contains(nix::net::if_::InterfaceFlags::IFF_UP)
            || flags.contains(nix::net::if_::InterfaceFlags::IFF_LOOPBACK)
        {
            continue;
        }
        let Some(addr) = ifa.address else { continue };
        let Some(sin) = addr.as_sockaddr_in() else { continue };
        let ip = Ipv4Addr::from(sin.ip());
        if out.iter().any(|a| a.name == ifa.interface_name) {
            continue; // first address per adapter
        }
        out.push(Adapter { name: ifa.interface_name.clone(), ip });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The address to bind for a chosen adapter, if it is present right now.
/// `None` chosen means automatic (bind to any); a chosen adapter that is not
/// in the list also yields `None`, which the senders treat as automatic until
/// it comes back. Pure, so both engines can pin it.
pub fn pick(adapters: &[Adapter], chosen: Option<&str>) -> Option<Ipv4Addr> {
    let name = chosen?;
    adapters.iter().find(|a| a.name == name).map(|a| a.ip)
}

/// `pick` against the live adapter list.
pub fn resolve(chosen: Option<&str>) -> Option<Ipv4Addr> {
    pick(&adapters(), chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<Adapter> {
        vec![
            Adapter { name: "en0".into(), ip: Ipv4Addr::new(10, 0, 0, 5) },
            Adapter { name: "en7".into(), ip: Ipv4Addr::new(192, 168, 200, 44) },
        ]
    }

    #[test]
    fn automatic_binds_to_nothing_in_particular() {
        assert_eq!(pick(&list(), None), None);
    }

    #[test]
    fn a_chosen_adapter_resolves_to_its_current_address() {
        assert_eq!(pick(&list(), Some("en7")), Some(Ipv4Addr::new(192, 168, 200, 44)));
    }

    #[test]
    fn an_adapter_that_is_gone_falls_back_to_automatic() {
        // unplugged: not in the list — the senders bind to any and say so
        assert_eq!(pick(&list(), Some("en11")), None);
    }

    #[test]
    fn the_live_list_never_offers_loopback() {
        assert!(adapters().iter().all(|a| !a.ip.is_loopback()));
    }
}
