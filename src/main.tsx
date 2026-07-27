import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Tabler icon webfont — bundled locally so every `<i class="ti ti-*">` renders. Imported before
// index.css so app styles can still layer on top. Vite fingerprints and bundles the woff2.
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
