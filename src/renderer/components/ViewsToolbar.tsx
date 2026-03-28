// @archigraph toolbar.views
import React from 'react';
import { useApp } from '../context/AppContext';
import { RenderMode } from '../../core/types';

const views = [
  { label: 'Front', action: 'front' },
  { label: 'Back', action: 'back' },
  { label: 'Left', action: 'left' },
  { label: 'Right', action: 'right' },
  { label: 'Top', action: 'top' },
  { label: 'Bottom', action: 'bottom' },
  { label: 'Iso', action: 'iso' },
] as const;

const renderModes: Array<{ label: string; mode: RenderMode }> = [
  { label: 'Wire', mode: 'wireframe' },
  { label: 'Shaded', mode: 'shaded' },
  { label: 'Textured', mode: 'textured' },
  { label: 'X-Ray', mode: 'xray' },
];

export function ViewsToolbar() {
  const { renderMode, setRenderMode, gridVisible, axesVisible, toggleGrid, toggleAxes, app } = useApp();

  const handleView = (view: string) => {
    app?.viewport.camera.setView(view as 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso');
  };

  const handleZoomExtents = () => {
    const box = app?.document.geometry.getBoundingBox();
    if (box) app?.viewport.camera.fitToBox(box);
  };

  return (
    <div className="views-toolbar">
      <div className="views-group">
        {views.map(v => (
          <button
            key={v.action}
            className="view-btn"
            onClick={() => handleView(v.action)}
            title={`${v.label} View`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="toolbar-separator" />

      <div className="views-group">
        {renderModes.map(rm => (
          <button
            key={rm.mode}
            className={`view-btn ${renderMode === rm.mode ? 'active' : ''}`}
            onClick={() => setRenderMode(rm.mode)}
            title={`${rm.label} Mode`}
          >
            {rm.label}
          </button>
        ))}
      </div>

      <div className="toolbar-separator" />

      <div className="views-group">
        <button onClick={handleZoomExtents} title="Zoom Extents">Extents</button>
        <button
          className={gridVisible ? 'active' : ''}
          onClick={toggleGrid}
          title="Toggle Grid"
        >Grid</button>
        <button
          className={axesVisible ? 'active' : ''}
          onClick={toggleAxes}
          title="Toggle Axes"
        >Axes</button>
      </div>

      <style>{`
        .views-toolbar {
          display: flex;
          align-items: center;
          height: var(--toolbar-height);
          padding: 0 4px;
          gap: 4px;
          background: var(--bg-secondary);
          border-top: 1px solid var(--border-color);
        }
        .views-group {
          display: flex;
          gap: 1px;
        }
        .view-btn {
          font-size: var(--font-size-small);
          padding: 2px 6px;
          height: 24px;
        }
        .toolbar-separator {
          width: 1px;
          height: 20px;
          background: var(--border-color);
          margin: 0 4px;
        }
      `}</style>
    </div>
  );
}
