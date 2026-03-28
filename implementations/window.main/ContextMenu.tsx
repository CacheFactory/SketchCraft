// @archigraph menu.context
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from './AppContext';

interface MenuItem {
  label: string;
  action: string;
  shortcut?: string;
  dividerAfter?: boolean;
  disabled?: boolean;
}

const emptySpaceItems: MenuItem[] = [
  { label: 'Paste', action: 'paste', shortcut: 'Ctrl+V' },
  { label: 'Select All', action: 'select-all', shortcut: 'Ctrl+A' },
  { label: 'Zoom Extents', action: 'zoom-extents', dividerAfter: true },
];

const faceItems: MenuItem[] = [
  { label: 'Entity Info', action: 'entity-info' },
  { label: 'Edit Material', action: 'edit-material', dividerAfter: true },
  { label: 'Reverse Face', action: 'reverse-face' },
  { label: 'Intersect Faces', action: 'intersect-faces', dividerAfter: true },
  { label: 'Make Group', action: 'make-group' },
  { label: 'Make Component', action: 'make-component' },
];

const edgeItems: MenuItem[] = [
  { label: 'Entity Info', action: 'entity-info' },
  { label: 'Divide', action: 'divide', dividerAfter: true },
  { label: 'Weld Edges', action: 'weld' },
  { label: 'Hide', action: 'hide' },
  { label: 'Soften', action: 'soften' },
];

const groupItems: MenuItem[] = [
  { label: 'Entity Info', action: 'entity-info' },
  { label: 'Edit Group', action: 'edit-group', dividerAfter: true },
  { label: 'Explode', action: 'explode' },
  { label: 'Make Unique', action: 'make-unique' },
  { label: 'Lock', action: 'lock', dividerAfter: true },
  { label: 'Hide', action: 'hide' },
];

export function ContextMenu() {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const { app, selectedEntityIds, selectedCount } = useApp();

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Only handle right-click on viewport canvas
      if ((e.target as HTMLElement).closest('.viewport-container')) {
        e.preventDefault();
        setPosition({ x: e.clientX, y: e.clientY });
        setVisible(true);
      }
    };

    const handleClick = () => setVisible(false);
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setVisible(false); };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const getMenuItems = (): MenuItem[] => {
    if (selectedCount === 0) return emptySpaceItems;

    // Determine selection type
    if (app) {
      const entity = app.document.scene.getEntity(selectedEntityIds[0]);
      if (!entity) return emptySpaceItems;

      switch (entity.type) {
        case 'face': return faceItems;
        case 'edge': return edgeItems;
        case 'group':
        case 'component_instance':
          return groupItems;
        default: return emptySpaceItems;
      }
    }
    return emptySpaceItems;
  };

  const handleAction = useCallback((action: string) => {
    setVisible(false);
    switch (action) {
      case 'select-all': app?.document.selection.selectAll(); break;
      case 'make-group': /* app.createGroupFromSelection() */ break;
      case 'explode': /* app.explodeSelection() */ break;
      case 'hide':
        selectedEntityIds.forEach(id => {
          const entity = app?.document.scene.getEntity(id);
          if (entity) entity.visible = false;
        });
        break;
      case 'delete':
        selectedEntityIds.forEach(id => app?.document.scene.removeEntity(id));
        break;
    }
  }, [app, selectedEntityIds]);

  if (!visible) return null;

  const items = getMenuItems();

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, i) => (
        <React.Fragment key={item.action}>
          <button
            className={`context-menu-item ${item.disabled ? 'disabled' : ''}`}
            onClick={() => !item.disabled && handleAction(item.action)}
            disabled={item.disabled}
          >
            <span className="cm-label">{item.label}</span>
            {item.shortcut && <span className="cm-shortcut">{item.shortcut}</span>}
          </button>
          {item.dividerAfter && <div className="cm-divider" />}
        </React.Fragment>
      ))}

      <style>{`
        .context-menu {
          position: fixed;
          z-index: 1000;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 4px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          padding: 4px 0;
          min-width: 180px;
        }
        .context-menu-item {
          display: flex;
          align-items: center;
          width: 100%;
          padding: 4px 12px;
          text-align: left;
          border-radius: 0;
          font-size: var(--font-size);
        }
        .context-menu-item:hover:not(:disabled) {
          background: var(--accent);
          color: white;
        }
        .cm-label { flex: 1; }
        .cm-shortcut {
          color: var(--text-muted);
          font-size: var(--font-size-small);
          margin-left: 16px;
        }
        .context-menu-item:hover .cm-shortcut { color: rgba(255,255,255,0.7); }
        .cm-divider {
          height: 1px;
          background: var(--border-color);
          margin: 4px 0;
        }
      `}</style>
    </div>
  );
}
