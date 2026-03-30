// @archigraph window.main
import React, { useEffect } from 'react';
import { AppProvider, useApp } from './AppContext';
import { DrawingToolbar } from './DrawingToolbar';
import { ViewsToolbar } from './ViewsToolbar';
import { EntityInfoPanel } from './EntityInfoPanel';
import { OutlinerPanel } from './OutlinerPanel';
import { LayersPanel } from './LayersPanel';
import { MeasurementsBar } from './MeasurementsBar';
import { ContextMenu } from './ContextMenu';
import { ToolSettingsPanel } from './ToolSettingsPanel';
import { ViewportCanvas } from '../viewport.main/ViewportCanvas';
import { DEFAULT_PREFERENCES } from '../../src/core/ipc-types';

export function App() {
  return (
    <AppProvider>
      <AppLayout />
    </AppProvider>
  );
}

// Build shortcut lookup tables from preferences (key -> toolId)
const shortcutMap: Record<string, string> = {};
const shiftShortcutMap: Record<string, string> = {};

for (const [toolId, binding] of Object.entries(DEFAULT_PREFERENCES.shortcuts)) {
  if (!toolId.startsWith('tool.')) continue;
  if (binding.startsWith('Shift+')) {
    shiftShortcutMap[binding.slice(6).toLowerCase()] = toolId;
  } else {
    shortcutMap[binding === 'Space' ? ' ' : binding.toLowerCase()] = toolId;
  }
}

function AppLayout() {
  const { theme, app, activateTool, undo, redo, updateState, syncToolState, syncPreviews } = useApp();

  // Handle keyboard shortcuts globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isArrow = e.key.startsWith('Arrow');

      // Don't handle tool shortcuts if focused on input/select or inside a dialog
      const tag = (e.target as HTMLElement).tagName;
      if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && !isArrow) return;
      if ((e.target as HTMLElement).closest('.text-input-dialog')) return;

      const isMeta = e.metaKey || e.ctrlKey;

      if (isMeta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (isMeta && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }

      // File operations
      if (isMeta && e.key === 's' && !e.shiftKey) { e.preventDefault(); (app as any)?.saveDocument(); return; }
      if (isMeta && e.key === 's' && e.shiftKey) { e.preventDefault(); (app as any)?.saveDocumentAs(); return; }
      if (isMeta && e.key === 'o') { e.preventDefault(); (app as any)?.openDocument(); return; }
      if (isMeta && e.key === 'n') { e.preventDefault(); (app as any)?.newDocument(); return; }

      // Tool shortcuts (from preferences)
      const key = e.key.toLowerCase();
      if (!isMeta && !e.shiftKey && shortcutMap[key]) {
        e.preventDefault();
        activateTool(shortcutMap[key]);
        return;
      }
      if (!isMeta && e.shiftKey && shiftShortcutMap[key]) {
        e.preventDefault();
        activateTool(shiftShortcutMap[key]);
        return;
      }

      // Escape: clear selection and deactivate tool
      if (e.key === 'Escape') {
        e.preventDefault();
        // Let active tool cancel in-progress operation
        const tool = (app as any)?.toolManager?.getActiveTool();
        if (tool) {
          tool.onKeyDown({
            key: e.key, code: e.code,
            shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey,
          });
        }
        (app as any)?.document?.selection?.clear();
        activateTool('tool.select');
        (app as any)?.syncScene?.();
        (app as any)?.syncSelection?.();
        syncPreviews();
        syncToolState();
        return;
      }

      // Arrow keys + Enter + Delete: forward to active tool
      if (isArrow || e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const tool = (app as any)?.toolManager?.getActiveTool();
        if (tool) {
          tool.onKeyDown({
            key: e.key, code: e.code,
            shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey,
          });
          (app as any)?.syncScene?.();
          (app as any)?.syncSelection?.();
          syncPreviews();
          syncToolState();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [app, activateTool, undo, redo, syncToolState, syncPreviews]);

  // Listen for menu actions from main process
  useEffect(() => {
    if (typeof window.api === 'undefined') return;

    const cleanup = window.api.on('menu:action', ({ action }) => {
      if (action === 'undo') { undo(); return; }
      if (action === 'redo') { redo(); return; }

      // Tool activation from menu
      if (typeof action === 'string' && action.startsWith('tool-')) {
        activateTool('tool.' + action.slice(5));
        return;
      }

      switch (action) {
        case 'delete': {
          const tool = (app as any)?.toolManager?.getActiveTool();
          if (tool) tool.onKeyDown({ key: 'Delete', code: 'Delete', shiftKey: false, ctrlKey: false, altKey: false });
          break;
        }
        case 'select-all':
          (app as any)?.document?.selection?.selectAll();
          break;
      }
    });

    return cleanup;
  }, [undo, redo, activateTool, app]);

  return (
    <div className="app-layout" data-theme={theme}>
      <div className="app-top-bar">
        <ViewsToolbar />
      </div>
      <div className="app-main">
        <DrawingToolbar />
        <div className="app-viewport-area">
          <ViewportCanvas />
        </div>
        <div className="app-right-panels">
          <ToolSettingsPanel />
          <EntityInfoPanel />
          <OutlinerPanel />
          <LayersPanel />
        </div>
      </div>
      <MeasurementsBar />
      <ContextMenu />

      <style>{`
        .app-layout {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          background: var(--bg-primary);
        }
        .app-top-bar {
          display: flex;
          flex-direction: column;
          border-bottom: 1px solid var(--border-color);
          flex-shrink: 0;
        }
        .app-main {
          display: flex;
          flex: 1;
          overflow: hidden;
        }
        .app-viewport-area {
          flex: 1;
          position: relative;
          overflow: hidden;
        }
        .app-right-panels {
          width: var(--panel-width);
          min-width: 200px;
          max-width: 400px;
          border-left: 1px solid var(--border-color);
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          background: var(--bg-secondary);
          resize: horizontal;
        }
      `}</style>
    </div>
  );
}
