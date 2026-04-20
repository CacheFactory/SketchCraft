// @archigraph web.menubar
// Browser menu bar replacing Electron native menus.
// Dispatches menu:action events through the WebPlatformBridge.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { MenuAction } from '../core/ipc-types';
import type { WebPlatformBridge } from './WebPlatformBridge';

interface MenuItem {
  label?: string;
  action?: MenuAction | string;
  separator?: boolean;
  shortcut?: string;
  disabled?: boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

const menus: Menu[] = [
  {
    label: 'File',
    items: [
      { label: 'New', action: 'new', shortcut: '⌘N' },
      { label: 'Open...', action: 'open', shortcut: '⌘O' },
      { separator: true },
      { label: 'Save', action: 'save', shortcut: '⌘S' },
      { label: 'Save As...', action: 'save-as', shortcut: '⇧⌘S' },
      { separator: true },
      { label: 'Import...', action: 'import' },
      { label: 'Export...', action: 'export' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', action: 'undo', shortcut: '⌘Z' },
      { label: 'Redo', action: 'redo', shortcut: '⇧⌘Z' },
      { separator: true },
      { label: 'Select All', action: 'select-all', shortcut: '⌘A' },
      { label: 'Delete', action: 'delete', shortcut: '⌫' },
      { separator: true },
      { label: 'Preferences...', action: 'preferences' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Zoom Extents', action: 'zoom-extents' },
    ],
  },
];

export function WebMenuBar() {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const dispatch = useCallback((action: string) => {
    const bridge = (window as any).api as WebPlatformBridge;
    if (bridge?.emit) {
      bridge.emit('menu:action', { action: action as MenuAction });
    }
    setOpenMenu(null);
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (openMenu === null) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenu]);

  return (
    <div className="web-menu-bar" ref={barRef}>
      {menus.map((menu, idx) => (
        <div
          key={menu.label}
          className={`web-menu-item ${openMenu === idx ? 'open' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); setOpenMenu(openMenu === idx ? null : idx); }}
          onMouseEnter={() => { if (openMenu !== null) setOpenMenu(idx); }}
        >
          <span className="web-menu-label">{menu.label}</span>
          {openMenu === idx && (
            <div className="web-menu-dropdown">
              {menu.items.map((item, i) =>
                item.separator ? (
                  <div key={i} className="web-menu-separator" />
                ) : (
                  <div
                    key={i}
                    className={`web-menu-dropdown-item ${item.disabled ? 'disabled' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!item.disabled && item.action) dispatch(item.action);
                    }}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="web-menu-shortcut">{item.shortcut}</span>}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      ))}

      <style>{`
        .web-menu-bar {
          display: flex;
          align-items: center;
          height: 28px;
          background: var(--bg-secondary, #1e1e1e);
          border-bottom: 1px solid var(--border-color, #333);
          font-size: 12px;
          color: var(--text-primary, #ccc);
          user-select: none;
          -webkit-app-region: no-drag;
          flex-shrink: 0;
        }
        .web-menu-item {
          position: relative;
          padding: 0 10px;
          height: 100%;
          display: flex;
          align-items: center;
          cursor: default;
        }
        .web-menu-item:hover, .web-menu-item.open {
          background: var(--bg-tertiary, #333);
        }
        .web-menu-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          min-width: 200px;
          background: var(--bg-secondary, #1e1e1e);
          border: 1px solid var(--border-color, #444);
          border-radius: 4px;
          padding: 4px 0;
          z-index: 10000;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .web-menu-dropdown-item {
          padding: 4px 24px 4px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 24px;
          cursor: default;
        }
        .web-menu-dropdown-item:hover:not(.disabled) {
          background: var(--accent, #4488ff);
          color: white;
        }
        .web-menu-dropdown-item.disabled {
          opacity: 0.4;
        }
        .web-menu-shortcut {
          font-size: 11px;
          opacity: 0.6;
        }
        .web-menu-separator {
          height: 1px;
          background: var(--border-color, #333);
          margin: 4px 0;
        }
      `}</style>
    </div>
  );
}
