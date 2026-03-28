// @archigraph panel.properties
import React, { useState } from 'react';
import { useApp } from './AppContext';

interface EntitySummary {
  id: string;
  type: string;
  label: string;
  detail: string;
}

export function EntityInfoPanel() {
  const { selectedCount, selectedEntityIds, app } = useApp();
  const [collapsed, setCollapsed] = useState(false);

  const getEntitySummary = (entityId: string): EntitySummary | null => {
    if (!app) return null;

    const face = app.document.geometry.getFace(entityId);
    if (face) {
      const area = app.document.geometry.computeFaceArea(entityId);
      const verts = face.vertexIds.length;
      return {
        id: entityId,
        type: 'Face',
        label: `Face (${verts} vertices)`,
        detail: `Area: ${area.toFixed(3)} m²`,
      };
    }

    const edge = app.document.geometry.getEdge(entityId);
    if (edge) {
      const length = app.document.geometry.computeEdgeLength(entityId);
      return {
        id: entityId,
        type: 'Edge',
        label: 'Edge',
        detail: `Length: ${length.toFixed(3)} m`,
      };
    }

    return { id: entityId, type: 'Unknown', label: 'Entity', detail: entityId.substring(0, 8) };
  };

  const getDetailedInfo = (entityId: string): Record<string, string> | null => {
    if (!app) return null;

    const face = app.document.geometry.getFace(entityId);
    if (face) {
      const area = app.document.geometry.computeFaceArea(entityId);
      const verts = app.document.geometry.getFaceVertices(entityId);
      return {
        'Vertices': `${verts.length}`,
        'Area': `${area.toFixed(4)} m²`,
        'Normal': `(${face.normal.x.toFixed(2)}, ${face.normal.y.toFixed(2)}, ${face.normal.z.toFixed(2)})`,
      };
    }

    const edge = app.document.geometry.getEdge(entityId);
    if (edge) {
      const length = app.document.geometry.computeEdgeLength(entityId);
      const v1 = app.document.geometry.getVertex(edge.startVertexId);
      const v2 = app.document.geometry.getVertex(edge.endVertexId);
      const info: Record<string, string> = { 'Length': `${length.toFixed(4)} m` };
      if (v1) info['Start'] = `(${v1.position.x.toFixed(2)}, ${v1.position.y.toFixed(2)}, ${v1.position.z.toFixed(2)})`;
      if (v2) info['End'] = `(${v2.position.x.toFixed(2)}, ${v2.position.y.toFixed(2)}, ${v2.position.z.toFixed(2)})`;
      return info;
    }

    return null;
  };

  const summaries = selectedEntityIds.map(id => getEntitySummary(id)).filter(Boolean) as EntitySummary[];
  const singleInfo = selectedCount === 1 ? getDetailedInfo(selectedEntityIds[0]) : null;

  // Component info
  const sm = app?.document?.scene as any;
  const selectedComponentId = selectedCount === 1 && sm?.components?.has(selectedEntityIds[0]) ? selectedEntityIds[0] : null;
  const selectedComponent = selectedComponentId ? sm.components.get(selectedComponentId) : null;
  const isEditingComponent = sm?.isEditingComponent ?? false;
  const editingComponentId = sm?.editingComponentId ?? null;

  const handleMakeComponent = () => {
    if (!sm || selectedEntityIds.length === 0) return;
    const name = `Component ${(sm.components?.size ?? 0) + 1}`;
    sm.createComponent(name, selectedEntityIds);
    app?.document?.selection?.clear();
    (app as any)?.syncScene?.();
  };

  const handleEditComponent = () => {
    if (!sm || !selectedComponentId) return;
    sm.enterComponent(selectedComponentId);
    app?.document?.selection?.clear();
    (app as any)?.syncScene?.();
  };

  const handleExitComponent = () => {
    if (!sm) return;
    sm.exitComponent();
    app?.document?.selection?.clear();
    (app as any)?.syncScene?.();
  };

  const handleExplodeComponent = () => {
    if (!sm || !selectedComponentId) return;
    sm.explodeComponent(selectedComponentId);
    app?.document?.selection?.clear();
    (app as any)?.syncScene?.();
  };

  return (
    <div className="panel entity-info-panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="panel-collapse">{collapsed ? '▸' : '▾'}</span>
        <span className="panel-title">Entity Info</span>
        {selectedCount > 0 && <span className="panel-badge">{selectedCount}</span>}
      </div>

      {!collapsed && (
        <div className="panel-body">
          {/* Component editing banner */}
          {isEditingComponent && (
            <div className="component-edit-banner">
              Editing: {sm.components.get(editingComponentId)?.name ?? 'Component'}
              <button className="component-exit-btn" onClick={handleExitComponent}>Close</button>
            </div>
          )}

          {selectedCount === 0 ? (
            <div className="panel-empty">{isEditingComponent ? 'Click geometry in this component' : 'No selection'}</div>
          ) : selectedComponent ? (
            <div className="entity-props">
              <div className="entity-type-badge">
                <span className="type-icon" style={{color: '#9c27b0'}}>🧩</span>
                <span className="type-label">{selectedComponent.name}</span>
              </div>
              <div className="prop-row">
                <span className="prop-label">Entities</span>
                <span className="prop-value">{selectedComponent.entityIds.size}</span>
              </div>
              <div className="component-actions">
                <button className="component-btn edit" onClick={handleEditComponent}>Edit Component</button>
                <button className="component-btn explode" onClick={handleExplodeComponent}>Explode</button>
              </div>
            </div>
          ) : selectedCount === 1 && singleInfo ? (
            <div className="entity-props">
              <div className="entity-type-badge">
                <span className={`type-icon type-${summaries[0]?.type.toLowerCase()}`}>
                  {summaries[0]?.type === 'Face' ? '▢' : summaries[0]?.type === 'Edge' ? '╱' : '◇'}
                </span>
                <span className="type-label">{summaries[0]?.type}</span>
              </div>
              {Object.entries(singleInfo).map(([key, value]) => (
                <div key={key} className="prop-row">
                  <span className="prop-label">{key}</span>
                  <span className="prop-value">{value}</span>
                </div>
              ))}
              {!isEditingComponent && (
                <button className="component-btn make" onClick={handleMakeComponent}>Make Component</button>
              )}
            </div>
          ) : (
            <div className="entity-list">
              <div className="entity-list-header">{selectedCount} entities selected</div>
              {!isEditingComponent && (
                <button className="component-btn make" onClick={handleMakeComponent}>Make Component</button>
              )}
              {summaries.map((s, i) => (
                <div key={s.id} className="entity-list-item">
                  <span className="entity-list-icon">
                    {s.type === 'Face' ? '▢' : s.type === 'Edge' ? '╱' : '◇'}
                  </span>
                  <span className="entity-list-label">{s.label}</span>
                  <span className="entity-list-detail">{s.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        .panel { border-bottom: 1px solid var(--border-color); }
        .panel-header {
          display: flex; align-items: center; padding: 6px 8px;
          cursor: pointer; background: var(--bg-tertiary); gap: 4px; font-weight: 500;
        }
        .panel-header:hover { background: var(--bg-hover); }
        .panel-collapse { font-size: 10px; color: var(--text-muted); }
        .panel-title { flex: 1; }
        .panel-badge {
          font-size: 10px; background: var(--accent); color: white;
          border-radius: 8px; padding: 0 6px; min-width: 16px; text-align: center;
        }
        .panel-body { padding: 8px; }
        .panel-empty {
          color: var(--text-muted); font-style: italic;
          text-align: center; padding: 12px;
        }
        .entity-props { display: flex; flex-direction: column; gap: 4px; }
        .entity-type-badge {
          display: flex; align-items: center; gap: 6px;
          padding: 4px 8px; margin-bottom: 4px;
          background: var(--bg-tertiary); border-radius: 4px;
        }
        .type-icon { font-size: 16px; width: 20px; text-align: center; }
        .type-icon.type-face { color: #4488ff; }
        .type-icon.type-edge { color: #44cc44; }
        .type-label { font-weight: 600; font-size: 13px; }
        .prop-row {
          display: flex; justify-content: space-between; align-items: center; padding: 2px 0;
        }
        .prop-label { color: var(--text-secondary); font-size: var(--font-size-small); }
        .prop-value { font-family: monospace; font-size: var(--font-size-small); }

        .entity-list { display: flex; flex-direction: column; gap: 2px; }
        .entity-list-header {
          font-size: var(--font-size-small); color: var(--text-secondary);
          padding: 2px 0 4px; border-bottom: 1px solid var(--border-color); margin-bottom: 4px;
        }
        .entity-list-item {
          display: flex; align-items: center; gap: 6px;
          padding: 3px 4px; border-radius: 3px;
          font-size: var(--font-size-small);
        }
        .entity-list-item:hover { background: var(--bg-hover); }
        .entity-list-icon { width: 16px; text-align: center; font-size: 12px; }
        .entity-list-label { flex: 1; }
        .entity-list-detail {
          color: var(--text-muted); font-family: monospace; font-size: 10px;
        }
        .component-edit-banner {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 8px; margin-bottom: 8px;
          background: #9c27b0; color: white;
          border-radius: 4px; font-size: 11px; font-weight: 500;
        }
        .component-exit-btn {
          background: rgba(255,255,255,0.2); color: white;
          padding: 2px 8px; border-radius: 3px; font-size: 10px;
        }
        .component-exit-btn:hover { background: rgba(255,255,255,0.3); }
        .component-actions {
          display: flex; gap: 6px; margin-top: 8px;
        }
        .component-btn {
          flex: 1; padding: 5px 8px; border-radius: 4px;
          font-size: 11px; font-weight: 500; text-align: center;
        }
        .component-btn.make {
          background: #9c27b0; color: white; margin-top: 8px;
        }
        .component-btn.make:hover { background: #7b1fa2; }
        .component-btn.edit {
          background: var(--accent); color: white;
        }
        .component-btn.edit:hover { background: var(--accent-hover); }
        .component-btn.explode {
          background: var(--bg-tertiary); color: var(--text-primary);
          border: 1px solid var(--border-color);
        }
        .component-btn.explode:hover { background: var(--bg-hover); }
      `}</style>
    </div>
  );
}
