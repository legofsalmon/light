import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initMidi } from './midi.ts';
import './tokens.css';
import './theme.css';

initMidi();

// Turning Tauri's own drag handler off (src-tauri/tauri.conf.json
// `dragDropEnabled: false`) is what lets HTML5 drag-and-drop reach the page at
// all — but it also hands OS drops straight to the webview, whose default is to
// NAVIGATE to the dropped file. A .gdtf dragged onto the window mid-show would
// replace the console with a download page. Nothing here ever wants that: the
// look-library drag calls preventDefault on its own targets, and imports go
// through the file picker. So refuse the default everywhere, always.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault());
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
