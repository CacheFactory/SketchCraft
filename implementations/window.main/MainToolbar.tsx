// @archigraph toolbar.main
// Top toolbar: file operations, undo/redo.
import React from 'react';
import { useApp } from './AppContext';

export function MainToolbar() {
  const { app, undo, redo, canUndo, canRedo, undoName, redoName, documentName, dirty } = useApp();

  const handleNew = () => (app as any)?.newDocument?.();
  const handleOpen = () => (app as any)?.openDocument?.();
  const handleSave = () => (app as any)?.saveDocument?.();
  const handleSaveAs = () => (app as any)?.saveDocumentAs?.();

  return (
    <div className="main-toolbar">
      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={handleNew} title="New (Cmd+N)">📄</button>
        <button className="toolbar-btn" onClick={handleOpen} title="Open (Cmd+O)">📂</button>
        <button className="toolbar-btn" onClick={handleSave} title="Save (Cmd+S)">💾</button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={undo} disabled={!canUndo}
          title={undoName ? `Undo ${undoName}` : 'Undo (Cmd+Z)'}>↩</button>
        <button className="toolbar-btn" onClick={redo} disabled={!canRedo}
          title={redoName ? `Redo ${redoName}` : 'Redo (Cmd+Shift+Z)'}>↪</button>
      </div>

      <div className="toolbar-separator" />

      <span className="app-title">{documentName}{dirty ? ' *' : ''}</span>

      <style>{`
        .main-toolbar {
          display: flex; align-items: center; height: var(--toolbar-height);
          padding: 0 8px; gap: 4px; background: var(--bg-secondary);
        }
        .toolbar-group { display: flex; align-items: center; gap: 1px; }
        .app-title {
          font-size: 12px; color: var(--text-secondary); padding: 0 4px;
        }
        .toolbar-separator {
          width: 1px; height: 20px; background: var(--border-color); margin: 0 4px;
        }
        .toolbar-btn {
          display: flex; align-items: center; justify-content: center;
          width: 30px; height: 28px; padding: 0; border-radius: 3px; font-size: 14px;
        }
      `}</style>
    </div>
  );
}
