// @archigraph process.renderer
// Entry point — kept in src/ for webpack. Imports from implementations/.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../implementations/window.main/App';
import '../../implementations/window.main/global.css';

// When running in a browser (no Electron preload), install the web platform bridge
if (typeof (window as any).api === 'undefined') {
  import('../web/WebPlatformBridge').then(({ WebPlatformBridge }) => {
    (window as any).api = new WebPlatformBridge();
    (window as any).__PLATFORM__ = 'web';
    mount();
  });
} else {
  mount();
}

function mount() {
  const container = document.getElementById('root');
  if (!container) throw new Error('Root element not found');
  const root = createRoot(container);
  root.render(<App />);
}
