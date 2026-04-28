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

function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
}

function MobileMessage() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: '#1e1e1e', color: '#eee', padding: '32px', textAlign: 'center',
    }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '12px' }}>DraftDown</h1>
      <p style={{ fontSize: '15px', color: '#888', lineHeight: 1.5 }}>
        View only on mobile.<br />Use a desktop browser to edit.
      </p>
    </div>
  );
}

const root = createRoot(container);
root.render(isMobile() ? <MobileMessage /> : <App />);
