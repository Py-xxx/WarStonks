import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Tabler icon webfont — bundled locally so every `<i class="ti ti-*">` renders. Imported before
// index.css so app styles can still layer on top. Vite fingerprints and bundles the woff2.
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import './index.css';

/**
 * Suppress the webview's native right-click menu — it exposes browser affordances (Reload, Back,
 * View Source, Save As…) that make a desktop app feel like a web page and can navigate the shell
 * away from the app.
 *
 * Text fields are deliberately exempt: right-click → paste is a real workflow here (Discord
 * webhook URLs, AlecaFrame links, search terms), and silently removing it would cost more than
 * the menu does.
 */
document.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) {
    return;
  }
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
