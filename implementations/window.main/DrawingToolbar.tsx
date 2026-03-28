// @archigraph toolbar.drawing
// Left sidebar: all tools that modify the model (draw, modify, measure, construct).
import React, { useState } from 'react';
import { useApp } from './AppContext';

interface ToolEntry {
  id: string;
  label: string;
  icon: string;
  shortcut: string;
}

interface ToolGroup {
  label: string;
  tools: ToolEntry[];
}

const toolGroups: ToolGroup[] = [
  {
    label: 'Select',
    tools: [
      { id: 'tool.select', label: 'Select', icon: '⬚', shortcut: 'Space' },
      { id: 'tool.eraser', label: 'Eraser', icon: '⌫', shortcut: 'E' },
    ],
  },
  {
    label: 'Draw',
    tools: [
      { id: 'tool.line', label: 'Line', icon: '╱', shortcut: 'L' },
      { id: 'tool.rectangle', label: 'Rectangle', icon: '▭', shortcut: 'R' },
      { id: 'tool.circle', label: 'Circle', icon: '○', shortcut: 'C' },
      { id: 'tool.arc', label: 'Arc', icon: '⌒', shortcut: 'A' },
      { id: 'tool.polygon', label: 'Polygon', icon: '⬡', shortcut: 'G' },
    ],
  },
  {
    label: 'Modify',
    tools: [
      { id: 'tool.pushpull', label: 'Push/Pull', icon: '⬈', shortcut: 'P' },
      { id: 'tool.move', label: 'Move', icon: '✥', shortcut: 'M' },
      { id: 'tool.rotate', label: 'Rotate', icon: '↻', shortcut: 'Q' },
      { id: 'tool.scale', label: 'Scale', icon: '⤢', shortcut: 'S' },
      { id: 'tool.offset', label: 'Offset', icon: '⟁', shortcut: 'F' },
      { id: 'tool.follow_me', label: 'Follow Me', icon: '↝', shortcut: 'Shift+F' },
      { id: 'tool.paint', label: 'Paint', icon: '🎨', shortcut: 'B' },
    ],
  },
  {
    label: 'Measure',
    tools: [
      { id: 'tool.tape_measure', label: 'Tape Measure', icon: '📏', shortcut: 'T' },
      { id: 'tool.protractor', label: 'Protractor', icon: '📐', shortcut: 'Shift+P' },
      { id: 'tool.dimension', label: 'Dimension', icon: '↔', shortcut: 'D' },
      { id: 'tool.text', label: 'Text', icon: 'T', shortcut: 'Shift+T' },
      { id: 'tool.section_plane', label: 'Section', icon: '✂', shortcut: 'Shift+S' },
    ],
  },
  {
    label: 'Navigate',
    tools: [
      { id: 'tool.orbit', label: 'Orbit', icon: '⟲', shortcut: 'O' },
      { id: 'tool.pan', label: 'Pan', icon: '✋', shortcut: 'H' },
      { id: 'tool.zoom', label: 'Zoom', icon: '🔍', shortcut: 'Z' },
    ],
  },
];

export function DrawingToolbar() {
  const { activeToolId, activateTool } = useApp();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleGroup = (label: string) => {
    setCollapsed(prev => ({ ...prev, [label]: !prev[label] }));
  };

  return (
    <div className="drawing-toolbar">
      {toolGroups.map(group => (
        <div key={group.label} className="tool-group">
          <div
            className="tool-group-header"
            onClick={() => toggleGroup(group.label)}
            title={group.label}
          >
            <span className="tool-group-arrow">{collapsed[group.label] ? '▸' : '▾'}</span>
            <span className="tool-group-label">{group.label}</span>
          </div>
          {!collapsed[group.label] && group.tools.map(tool => (
            <button
              key={tool.id}
              className={`sidebar-tool-btn ${activeToolId === tool.id ? 'active' : ''}`}
              onClick={() => activateTool(tool.id)}
              title={`${tool.label} (${tool.shortcut})`}
            >
              <span className="tool-btn-icon">{tool.icon}</span>
              <span className="tool-btn-label">{tool.label}</span>
            </button>
          ))}
        </div>
      ))}

      <style>{`
        .drawing-toolbar {
          width: 120px;
          min-width: 120px;
          background: var(--bg-secondary);
          border-right: 1px solid var(--border-color);
          display: flex;
          flex-direction: column;
          padding: 4px 0;
          overflow-y: auto;
        }
        .tool-group {
          display: flex;
          flex-direction: column;
          width: 100%;
          border-bottom: 1px solid var(--border-color);
          padding-bottom: 2px;
          margin-bottom: 2px;
        }
        .tool-group-header {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          font-size: 10px;
          color: var(--text-muted);
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .tool-group-header:hover { color: var(--text-secondary); }
        .tool-group-arrow { font-size: 8px; }
        .tool-group-label { flex: 1; }
        .sidebar-tool-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          height: 26px;
          padding: 0 8px;
          font-size: 12px;
          border-radius: 0;
          text-align: left;
        }
        .sidebar-tool-btn:hover { background: var(--bg-hover); }
        .sidebar-tool-btn.active {
          background: var(--bg-active);
          color: #fff;
        }
        .tool-btn-icon {
          width: 18px;
          text-align: center;
          font-size: 13px;
        }
        .tool-btn-label {
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `}</style>
    </div>
  );
}
