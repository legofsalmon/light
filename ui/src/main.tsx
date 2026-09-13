import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initMidi } from './midi.ts';
import { registerShortcutActions } from './shortcuts.ts';
import { openLibrarySheet, useLibraryStore } from './libraryStore.ts';
import { openFind } from './components/Find.tsx';
import { openSetup } from './components/AdminModal.tsx';
import './tokens.css';
import './theme.css';

initMidi();

// The keyboard table names these; the browser owns them. Registered here so
// shortcuts.ts stays importable by the Node suite that holds the published key
// table against what the handler binds.
registerShortcutActions({
  openLibrary: () => openLibrarySheet(),
  openFind: () => openFind(),
  openSetup: () => openSetup(),
  disarmLibrary: () => {
    if (!useLibraryStore.getState().armed) return false;
    useLibraryStore.getState().disarm();
    return true;
  },
});

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
