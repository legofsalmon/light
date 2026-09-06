// The one door out of the app: a link, opened in the system browser.
//
// A WKWebView with no new-window handler drops a target="_blank" click on the
// floor, so a plain <a> in the packaged app went nowhere — the licence page
// and the release page were dead links (review; backlog item 8). Inside the
// shell this hands the URL to macOS; in a browser or on the tablet,
// window.open is the right thing and works.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function bridge(): Invoke | null {
  const t = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return t?.core?.invoke ?? null;
}

export function openExternal(url: string | undefined | null): void {
  if (!url) return;
  const invoke = bridge();
  if (invoke) {
    invoke<void>('open_url', { url }).catch(() => window.open(url, '_blank', 'noopener'));
    return;
  }
  window.open(url, '_blank', 'noopener');
}
