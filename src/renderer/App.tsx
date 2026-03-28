// @archigraph window.main
import React, { useEffect, useRef, useCallback } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { MainToolbar } from './components/MainToolbar';
import { DrawingToolbar } from './components/DrawingToolbar';
import { ViewsToolbar } from './components/ViewsToolbar';
import { EntityInfoPanel } from './components/EntityInfoPanel';
import { OutlinerPanel } from './components/OutlinerPanel';
import { LayersPanel } from './components/LayersPanel';
import { MeasurementsBar } from './components/MeasurementsBar';
import { ContextMenu } from './components/ContextMenu';
import { ViewportCanvas } from './components/ViewportCanvas';

export function App() {
  return (
    <AppProvider>
      <AppLayout />
    </AppProvider>
  );
}

function AppLayout() {
  const { theme, app, activateTool, undo, redo, setRenderMode, updateState } = useApp();

  // Handle keyboard shortcuts globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Arrow keys always go to tools, even from input fields
      const isArrow = e.key.startsWith('Arrow');

      // Don't handle tool shortcuts if focused on input (except arrow keys)
      if ((e.target as HTMLElement).tagName === 'INPUT' && !isArrow) return;

      const isMeta = e.metaKey || e.ctrlKey;

      if (isMeta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (isMeta && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }

      // File operations
      const appInst = (window as any).__debugApp;
      if (isMeta && e.key === 's' && !e.shiftKey) { e.preventDefault(); appInst?.saveDocument(); return; }
      if (isMeta && e.key === 's' && e.shiftKey) { e.preventDefault(); appInst?.saveDocumentAs(); return; }
      if (isMeta && e.key === 'o') { e.preventDefault(); appInst?.openDocument(); return; }
      if (isMeta && e.key === 'n') { e.preventDefault(); appInst?.newDocument(); return; }

      // Tool shortcuts
      const shortcuts: Record<string, string> = {
        ' ': 'tool.select', l: 'tool.line', r: 'tool.rectangle',
        c: 'tool.circle', a: 'tool.arc', p: 'tool.pushpull',
        m: 'tool.move', q: 'tool.rotate', s: 'tool.scale',
        f: 'tool.offset', e: 'tool.eraser', b: 'tool.paint',
        o: 'tool.orbit', h: 'tool.pan', z: 'tool.zoom',
        t: 'tool.tape_measure', d: 'tool.dimension', g: 'tool.polygon',
      };

      const key = e.key.toLowerCase();
      if (!isMeta && shortcuts[key]) {
        e.preventDefault();
        activateTool(shortcuts[key]);
        return;
      }

      // Arrow keys + Escape + Enter: forward to active tool
      if (e.key.startsWith('Arrow') || e.key === 'Escape' || e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const appInst = (window as any).__debugApp;
        if (appInst) {
          const tool = appInst.toolManager.getActiveTool();
          if (tool) {
            tool.onKeyDown({
              key: e.key, code: e.code,
              shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey,
            });
            appInst.syncScene();
            if (appInst.sceneBridge) {
              const preview = tool.getPreview();
              appInst.sceneBridge.clearPreviewEdges();
              appInst.sceneBridge.clearRubberBand();
              if (preview) {
                if (preview.polygon && preview.polygon.length >= 2) appInst.sceneBridge.setPreviewRect(preview.polygon);
                if (preview.lines) for (const line of preview.lines) appInst.sceneBridge.setRubberBand(line.from, line.to);
              }
            }
            updateState({
              vcbLabel: tool.getVCBLabel(),
              vcbValue: tool.getVCBValue(),
              statusText: tool.getStatusText(),
            });
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activateTool, undo, redo]);

  // Listen for menu actions from main process
  useEffect(() => {
    if (typeof window.api === 'undefined') return;

    const cleanup = window.api.on('menu:action', ({ action }) => {
      // Undo/redo
      if (action === 'undo') { undo(); return; }
      if (action === 'redo') { redo(); return; }

      // Tool activation from menu
      if (typeof action === 'string' && action.startsWith('tool-')) {
        const toolId = 'tool.' + action.slice(5); // 'tool-line' -> 'tool.line'
        activateTool(toolId);
        return;
      }

      // Other menu actions
      switch (action) {
        case 'delete':
          // Forward delete to active tool's keydown
          const tool = app?.toolManager?.getActiveTool();
          if (tool) tool.onKeyDown({ key: 'Delete', code: 'Delete', shiftKey: false, ctrlKey: false, altKey: false });
          break;
        case 'select-all':
          app?.document?.selection?.selectAll();
          break;
      }
    });

    return cleanup;
  }, [undo, redo, activateTool, app]);

  return (
    <div className="app-layout" data-theme={theme}>
      <div className="app-top-bar">
        <MainToolbar />
        <ViewsToolbar />
      </div>
      <div className="app-main">
        <DrawingToolbar />
        <div className="app-viewport-area">
          <ViewportCanvas />
        </div>
        <div className="app-right-panels">
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
