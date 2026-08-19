import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Command, ServerEvent } from '../shared/types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/** HTTP (serves the built UI, if present) + WebSocket command/event channel. */
export class Server {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  onConnect: ((ws: WebSocket) => void) | null = null;
  onDisconnect: ((clientId: number) => void) | null = null;
  private nextClientId = 1;

  constructor(port: number, distDir: string, onCommand: (cmd: Command, ws: WebSocket, clientId: number) => void) {
    this.httpServer = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      const rel = url === '/' ? 'index.html' : url.slice(1);
      const file = path.join(distDir, path.normalize(rel));
      // path.sep suffix: "dist" must not also authorise "dist-evil"
      if (file !== distDir && !file.startsWith(distDir + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const serve = (f: string) => {
        fs.readFile(f, (err, data) => {
          if (err) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('LIGHT engine is running. Build the UI (npm run build) or use the dev server on :5173.');
            return;
          }
          res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
          res.end(data);
        });
      };
      fs.stat(file, (err, st) => {
        if (!err && st.isFile()) serve(file);
        else serve(path.join(distDir, 'index.html')); // SPA fallback
      });
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      // holds are attributed to this id so a disconnect releases only its own
      const clientId = this.nextClientId++;
      this.onConnect?.(ws);
      ws.on('close', () => this.onDisconnect?.(clientId));
      ws.on('message', (data) => {
        let cmd: Command;
        try {
          cmd = JSON.parse(String(data)) as Command;
        } catch {
          return;
        }
        try {
          onCommand(cmd, ws, clientId);
        } catch (err) {
          console.error('[server] command failed:', (err as Error).message);
        }
      });
    });

    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[light] port ${port} is already in use — another LIGHT engine (or the packaged app) is running. Quit it and start again.`
        );
      } else {
        console.error('[light] server error:', err.message);
      }
      process.exit(1);
    });
    this.httpServer.listen(port);
    this.httpServer.on('error', (err) => {
      console.error(`[server] cannot listen on :${port} — is another engine running?`, err.message);
      process.exit(1);
    });
  }

  send(ws: WebSocket, ev: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  }

  /** Broadcast to everyone except one client. Used for the project echo when
   *  every change since the last one came from that client: it already holds
   *  this state, and sending it back lands on top of whatever the operator has
   *  dragged or typed since, silently discarding it. `skip` is compared by
   *  identity, so passing null reaches everyone. Mirrors Broadcaster::
   *  broadcast_except in core/src/server.rs. */
  broadcastExcept(skip: unknown, ev: ServerEvent): void {
    const s = JSON.stringify(ev);
    for (const c of this.wss.clients) {
      if (c === skip) continue;
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1_000_000) c.send(s);
    }
  }

  broadcast(ev: ServerEvent): void {
    const s = JSON.stringify(ev);
    for (const c of this.wss.clients) {
      // A stalled client must not buffer unbounded snapshot backlog in the
      // engine — skip it until it drains (snapshots are disposable).
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1_000_000) c.send(s);
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  close(): void {
    this.wss.close();
    this.httpServer.close();
  }
}
