import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One source of truth for the version: package.json, which is also what
// tauri.conf.json carries and what the release tag has to match. Injected at
// build time so the running console can say which build it is — "is this the
// one with the fix?" was previously unanswerable from the screen.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
