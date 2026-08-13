import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initMidi } from './midi.ts';
import './theme.css';

initMidi();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
