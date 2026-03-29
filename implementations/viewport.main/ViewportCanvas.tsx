// @archigraph viewport.main
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useApp } from '../window.main/AppContext';
import { Application } from '../process.renderer/Application';
import { TextInputDialog, TextInputResult } from '../window.main/TextInputDialog';
import { TextTool, TextPlacementRequest } from '../tool.text/textTool';
import type { ToolMouseEvent } from '../../src/core/interfaces';
import type { Vec3 } from '../../src/core/types';

interface TextDialogState {
  screenX: number;
  screenY: number;
  worldPoint: Vec3;
}

export function ViewportCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const appInstanceRef = useRef<Application | null>(null);
  const { setApp, activateTool, updateState } = useApp();
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number; mode: string } | null>(null);
  const [textDialog, setTextDialog] = useState<TextDialogState | null>(null);

  /** Push selection state from the app into React context. */
  const syncSelectionToUI = useCallback(() => {
    const app = appInstanceRef.current;
    if (!app) return;

    const { entityIds, count } = app.syncSelection();
    updateState({
      selectedEntityIds: entityIds,
      selectedCount: count,
    });
  }, [updateState]);

  /** Push tool + selection state into React after any interaction. */
  const syncAfterAction = useCallback(() => {
    const app = appInstanceRef.current;
    if (!app) return;

    app.syncScene();
    syncSelectionToUI();

    const tool = app.toolManager.getActiveTool();
    if (tool) {
      // Clear preview if tool returned to idle (action completed)
      const preview = tool.getPreview();
      if (!preview && app.sceneBridge) {
        app.sceneBridge.clearPreviewEdges();
        app.sceneBridge.clearRubberBand();
      }

      updateState({
        vcbLabel: tool.getVCBLabel(),
        vcbValue: tool.getVCBValue(),
        statusText: tool.getStatusText(),
      });
    }
  }, [syncSelectionToUI, updateState]);

  // Initialize the Application when the container mounts
  useEffect(() => {
    const container = containerRef.current;
    if (!container || appInstanceRef.current) return;

    const app = new Application();
    appInstanceRef.current = app;

    app.initialize(container).then(() => {
      setApp(app);
      activateTool('tool.select');
      (window as any).__debugApp = app;

      // Wire up text tool dialog callback
      const textTool = app.toolManager.getTool('tool.text') as TextTool | undefined;
      if (textTool) {
        textTool.onRequestTextInput = (req: TextPlacementRequest) => {
          setTextDialog({ screenX: req.screenX, screenY: req.screenY, worldPoint: req.worldPoint });
        };
      }

      console.log('Application fully initialized');
    }).catch(err => {
      console.error('Failed to initialize application:', err);
    });

    // Listen for mouseUp on window to catch releases outside the container
    const onWindowMouseUp = (e: MouseEvent) => {
      // Always clear middle mouse state
      if (e.button === 1) {
        middleMouseRef.current.active = false;
      }
    };
    window.addEventListener('mouseup', onWindowMouseUp);

    // Attach native wheel listener (non-passive) so we can preventDefault
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const a = appInstanceRef.current;
      if (!a?.viewport?.camera) return;

      const delta = -e.deltaY * 0.003;

      // Find the world point under the cursor to zoom toward it
      const canvas = container.querySelector('canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const worldPoint = a.viewport.screenToWorld(screenX, screenY);

        const cam = a.viewport.camera as any;
        if (cam.zoomToward) {
          cam.zoomToward(delta, worldPoint);
        } else {
          cam.zoom(delta);
        }
      } else {
        a.viewport.camera.zoom(delta);
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      window.removeEventListener('mouseup', onWindowMouseUp);
      container.removeEventListener('wheel', onWheel);
      appInstanceRef.current?.dispose();
      appInstanceRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getToolEvent = useCallback((e: React.MouseEvent): ToolMouseEvent | null => {
    const app = appInstanceRef.current;
    if (!app?.viewport) return null;

    // Use the container's bounding rect for coordinates.
    // The canvas is sized by Three.js setSize() to match the container exactly
    // (via ResizeObserver), so container rect == canvas rect.
    const container = containerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    let worldPoint = app.viewport.screenToWorld(screenX, screenY);

    // Raycast to find entity under cursor (skip hidden/locked layers)
    const hits = app.viewport.raycastScene(screenX, screenY);
    const sm = app.document.scene as any;
    let hitEntityId: string | null = null;
    let hitPoint: { x: number; y: number; z: number } | null = null;

    for (const h of hits) {
      if (sm?.isEntityVisible && !sm.isEntityVisible(h.entityId)) continue;
      if (sm?.isEntityLocked && sm.isEntityLocked(h.entityId)) continue;

      // If entity is in a component and we're not editing that component,
      // return the component ID instead (select the whole component)
      if (sm?.getEntityComponent && sm?.isEntityProtected) {
        if (sm.isEntityProtected(h.entityId)) {
          const compId = sm.getEntityComponent(h.entityId);
          if (compId) {
            hitEntityId = compId; // Select the component, not the face
            hitPoint = h.point;
            break;
          }
        }
      }

      hitEntityId = h.entityId;
      hitPoint = h.point;
      break;
    }

    // Snap to nearby vertex endpoints for draw/measure/construct/modify tools
    const activeTool = app.toolManager.getActiveTool();
    const snapCategories = new Set(['draw', 'measure', 'construct', 'modify']);
    const isSnapTool = activeTool ? snapCategories.has(activeTool.category) : false;

    if (isSnapTool && app.sceneBridge) {
      const snapped = app.sceneBridge.findSnapPoint(
        screenX, screenY, worldPoint,
        app.viewport.getWidth(), app.viewport.getHeight(),
        app.viewport.camera, 15,
      );
      if (snapped) worldPoint = snapped;
    } else if (app.sceneBridge) {
      app.sceneBridge.hideSnapMarker();
    }

    return {
      screenX, screenY, worldPoint,
      inference: null,
      hitEntityId, hitPoint,
      button: e.button,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
    };
  }, []);

  // Middle mouse button orbit state
  const middleMouseRef = useRef<{ active: boolean; lastX: number; lastY: number; shift: boolean }>({
    active: false, lastX: 0, lastY: 0, shift: false,
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) return; // right click = context menu

    // Middle mouse button: orbit (or pan with shift)
    if (e.button === 1) {
      e.preventDefault();
      middleMouseRef.current = {
        active: true,
        lastX: e.clientX,
        lastY: e.clientY,
        shift: e.shiftKey,
      };

      // Set orbit pivot to point under cursor
      const app = appInstanceRef.current;
      if (app && !e.shiftKey) {
        const ev = getToolEvent(e);
        if (ev?.worldPoint) {
          const cam = app.viewport.camera as any;
          if (cam.setOrbitPivot) cam.setOrbitPivot(ev.worldPoint);
        }
      }
      return;
    }

    const app = appInstanceRef.current;
    const tool = app?.toolManager.getActiveTool();
    if (!tool) return;

    const ev = getToolEvent(e);
    if (!ev) return;

    tool.onMouseDown(ev);
    syncAfterAction();
  }, [getToolEvent, syncAfterAction]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const app = appInstanceRef.current;

    // Safety: if we think middle mouse is down but no buttons are pressed, reset
    if (middleMouseRef.current.active && e.buttons === 0) {
      middleMouseRef.current.active = false;
    }

    // Middle mouse orbit/pan
    if (middleMouseRef.current.active && app) {
      const dx = e.clientX - middleMouseRef.current.lastX;
      const dy = e.clientY - middleMouseRef.current.lastY;
      middleMouseRef.current.lastX = e.clientX;
      middleMouseRef.current.lastY = e.clientY;

      if (middleMouseRef.current.shift) {
        app.viewport.camera.pan(dx, dy);
      } else {
        app.viewport.camera.orbit(dx, dy);
      }
      return;
    }

    const tool = app?.toolManager.getActiveTool();
    if (!tool) return;

    const ev = getToolEvent(e);
    if (!ev) return;

    tool.onMouseMove(ev);

    // Sync scene on every mouse move for modify tools in active phase
    // (Move/Rotate/Scale/Offset/PushPull modify vertex positions in onMouseMove)
    if (app && tool.category === 'modify') {
      app.syncScene();
    }

    // Render live tool preview (rubber-band lines, rectangle outlines, etc.)
    if (app?.sceneBridge) {
      const preview = tool.getPreview();
      app.sceneBridge.clearPreviewEdges();
      app.sceneBridge.clearRubberBand();

      if (preview) {
        if (preview.polygon && preview.polygon.length >= 2) {
          app.sceneBridge.setPreviewRect(preview.polygon);
        }
        if (preview.lines) {
          for (const line of preview.lines) {
            app.sceneBridge.setRubberBand(line.from, line.to);
          }
        }
      }
    }

    // Update drag box overlay for Select tool
    if (tool.id === 'tool.select' && (tool as any).getDragBox) {
      const box = (tool as any).getDragBox();
      if (box) {
        setDragBox({ x: box.x, y: box.y, w: box.width, h: box.height, mode: box.mode });
      } else {
        setDragBox(null);
      }
    }

    // Sync pre-selection highlight on hover (for Select tool)
    syncSelectionToUI();

    // Update status/VCB
    updateState({
      vcbValue: tool.getVCBValue(),
      statusText: tool.getStatusText(),
    });
  }, [getToolEvent, syncSelectionToUI, updateState]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // Middle mouse release
    if (e.button === 1) {
      middleMouseRef.current.active = false;
      return;
    }

    const app = appInstanceRef.current;
    const tool = app?.toolManager.getActiveTool();
    if (!tool) return;

    const ev = getToolEvent(e);
    if (!ev) return;

    tool.onMouseUp(ev);
    setDragBox(null);
    syncAfterAction();
  }, [getToolEvent, syncAfterAction]);

  // Wheel zoom is handled via native event listener (see useEffect above)
  // to allow preventDefault on non-passive listener.

  // Key events are handled globally in App.tsx to avoid double-firing issues.
  // No onKeyDown handler on the container.

  return (
    <div
      ref={containerRef}
      className="viewport-container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      tabIndex={0}
    >
      {dragBox && (
        <div
          className={`drag-select-box ${dragBox.mode === 'crossing' ? 'crossing' : 'window'}`}
          style={{
            left: dragBox.x,
            top: dragBox.y,
            width: dragBox.w,
            height: dragBox.h,
          }}
        />
      )}
      {textDialog && (
        <TextInputDialog
          x={textDialog.screenX}
          y={textDialog.screenY}
          onSubmit={(result: TextInputResult) => {
            const app = appInstanceRef.current;
            const textTool = app?.toolManager.getActiveTool() as TextTool | undefined;
            if (textTool?.placeText) {
              textTool.placeText(result);
            }
            setTextDialog(null);
          }}
          onCancel={() => {
            const app = appInstanceRef.current;
            const textTool = app?.toolManager.getActiveTool() as TextTool | undefined;
            if (textTool?.cancelPlacement) {
              textTool.cancelPlacement();
            }
            setTextDialog(null);
          }}
        />
      )}
      <style>{`
        .drag-select-box {
          position: absolute;
          pointer-events: none;
          z-index: 100;
          border: 1.5px solid #0078d4;
        }
        .drag-select-box.window {
          background: rgba(0, 120, 212, 0.1);
          border-style: solid;
        }
        .drag-select-box.crossing {
          background: rgba(0, 200, 100, 0.1);
          border-style: dashed;
          border-color: #00c864;
        }
        .viewport-container {
          width: 100%;
          height: 100%;
          position: relative;
          overflow: hidden;
          outline: none;
          cursor: crosshair;
        }
        .viewport-container canvas {
          display: block;
        }
      `}</style>
    </div>
  );
}
