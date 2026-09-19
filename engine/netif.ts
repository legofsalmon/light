// Which network adapter the rig lives on.
//
// A Mac at a gig is rarely on one network: a phone tethers, a VPN comes up, a
// second adapter gets plugged in. With the send socket bound to "any
// interface" the OS picks where a packet goes, and for a BROADCAST it picks
// whichever interface holds the default route — one night that was the phone,
// and every Art-Net frame left the laptop on the wrong wire while the app read
// "live". Binding the socket to a chosen adapter makes every send, broadcast
// or unicast, leave on that adapter whatever else is plugged in.
//
// The choice is by adapter NAME (`en7`), resolved to its current address each
// time a socket is opened, so a DHCP renewal or a cable swap on the same
// adapter is picked up by the senders' reconcile loop. An adapter that is gone
// resolves to nothing and the senders fall back to "any" until it returns.
//
// Twin of core/src/netif.rs; `pick` carries the same tests on both sides.

import os from 'node:os';

/** One usable adapter: up, IPv4, not loopback. */
export type Adapter = { name: string; ip: string };

/** Every adapter a socket could be bound to, sorted by name, one address
 *  each (the first IPv4 the OS lists for it). */
export function adapters(): Adapter[] {
  const out: Adapter[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    const v4 = (infos ?? []).find((i) => i.family === 'IPv4' && !i.internal);
    if (v4) out.push({ name, ip: v4.address });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The address to bind for a chosen adapter, if it is present right now.
 *  `null` chosen means automatic (bind to any); a chosen adapter that is not
 *  in the list also yields `null`, which the senders treat as automatic until
 *  it comes back. Pure, so the smoke suite can pin it. */
export function pick(list: Adapter[], chosen: string | null): string | null {
  if (chosen === null) return null;
  return list.find((a) => a.name === chosen)?.ip ?? null;
}

/** `pick` against the live adapter list. */
export function resolve(chosen: string | null): string | null {
  return pick(adapters(), chosen);
}
