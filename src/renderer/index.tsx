// @archigraph process.renderer
// Entry point — kept in src/ for webpack. Imports from implementations/.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../implementations/window.main/App';
import '../../implementations/window.main/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const root = createRoot(container);
root.render(<App />);
