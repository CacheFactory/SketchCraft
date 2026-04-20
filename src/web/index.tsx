// @archigraph web.entry
// Web entry point — installs WebPlatformBridge as window.api, then renders the app.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { WebPlatformBridge } from './WebPlatformBridge';
import { App } from '../../implementations/window.main/App';
import '../../implementations/window.main/global.css';

// Install the web platform bridge so existing code that calls window.api works unchanged
const bridge = new WebPlatformBridge();
(window as any).api = bridge;

// Mark platform for conditional checks
(window as any).__PLATFORM__ = 'web';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const root = createRoot(container);
root.render(<App />);
