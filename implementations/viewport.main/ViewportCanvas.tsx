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
  const { setApp, activateTool, updateState, syncPreviews } = useApp();
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
    syncPreviews();

    const tool = app.toolManager.getActiveTool();
    if (tool) {
      updateState({
        vcbLabel: tool.getVCBLabel(),
        vcbValue: tool.getVCBValue(),
        statusText: tool.getStatusText(),
      });
    }
  }, [syncSelectionToUI, syncPreviews, updateState]);

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

  /** Resolve raycast hit through scene manager (layer visibility, components). */
  const resolveHit = useCallback((
    hits: Array<{ entityId: string; point: Vec3; distance: number }>,
    sm: any,
  ): { hitEntityId: string | null; hitPoint: Vec3 | null } => {
    for (const h of hits) {
      if (sm?.isEntityVisible && !sm.isEntityVisible(h.entityId)) continue;
      if (sm?.isEntityLocked && sm.isEntityLocked(h.entityId)) continue;
      if (sm?.getEntityComponent && sm?.isEntityProtected) {
        if (sm.isEntityProtected(h.entityId)) {
          const compId = sm.getEntityComponent(h.entityId);
          if (compId) return { hitEntityId: compId, hitPoint: h.point };
        }
      }
      return { hitEntityId: h.entityId, hitPoint: h.point };
    }
    return { hitEntityId: null, hitPoint: null };
  }, []);

  /** Full tool event with raycast + snap (used for clicks and draw/modify tools). */
  const getToolEvent = useCallback((e: React.MouseEvent): ToolMouseEvent | null => {
    const t0 = performance.now();
    const app = appInstanceRef.current;
    if (!app?.viewport) return null;
    const container = containerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    let worldPoint = app.viewport.screenToWorld(screenX, screenY);

    // Skip full raycast and snap in batched mode (view-only, no per-entity objects)
    const renderer = app.viewport.renderer as any;
    const hasPicking = renderer.hasEntityObjects ? renderer.hasEntityObjects() : false;

    let hitEntityId: string | null = null;
    let hitPoint: Vec3 | null = null;

    if (hasPicking) {
      const hits = app.viewport.raycastScene(screenX, screenY);
      const dt = performance.now() - t0;
      if (dt > 10) console.warn(`[getToolEvent] raycast took ${dt.toFixed(1)}ms`);
      const sm = app.document.scene as any;
      const resolved = resolveHit(hits, sm);
      hitEntityId = resolved.hitEntityId;
      hitPoint = resolved.hitPoint;

      // Snap detection for drawing/modify tools
      const activeTool = app.toolManager.getActiveTool();
      const noSnapTools = new Set(['tool.select', 'tool.paint', 'tool.eraser']);
      const snapCategories = new Set(['draw', 'measure', 'construct', 'modify']);
      const isSnapTool = activeTool
        ? snapCategories.has(activeTool.category) && !noSnapTools.has(activeTool.id)
        : false;

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
  }, [resolveHit]);

  /** GPU-pick only tool event — O(1), used for hover on select/paint/eraser. */
  const getToolEventGpuOnly = useCallback((e: React.MouseEvent): ToolMouseEvent | null => {
    const app = appInstanceRef.current;
    if (!app?.viewport) return null;
    const container = containerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const worldPoint = app.viewport.screenToWorld(screenX, screenY);

    // GPU pick: O(1) pixel read, no scene traversal
    const renderer = app.viewport.renderer as any;
    let hitEntityId: string | null = null;
    if (renderer.gpuPick) {
      hitEntityId = renderer.gpuPick(screenX, screenY);
    }

    return {
      screenX, screenY, worldPoint,
      inference: null,
      hitEntityId, hitPoint: worldPoint,
      button: e.button,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
    };
  }, []);

  /** GPU pick + optional edge-only raycast fallback — used for clicks on select/paint/eraser.
   *  Skips raycast in batched mode (no per-entity objects = view-only). */
  const getToolEventLight = useCallback((e: React.MouseEvent): ToolMouseEvent | null => {
    const app = appInstanceRef.current;
    if (!app?.viewport) return null;
    const container = containerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const worldPoint = app.viewport.screenToWorld(screenX, screenY);

    // GPU pick for faces: O(1)
    const renderer = app.viewport.renderer as any;
    let hitEntityId: string | null = null;
    let hitPoint: Vec3 | null = worldPoint;
    if (renderer.gpuPick) {
      hitEntityId = renderer.gpuPick(screenX, screenY);
    }

    // Only attempt edge raycast if there are per-entity objects registered.
    // In batched mode (large models), there are none — selection is disabled.
    if (!hitEntityId && renderer.hasEntityObjects && renderer.hasEntityObjects()) {
      const vp = app.viewport as any;
      if (vp.raycastEdgesOnly) {
        const edgeHits = vp.raycastEdgesOnly(screenX, screenY);
        const sm = app.document.scene as any;
        const resolved = resolveHit(edgeHits, sm);
        if (resolved.hitEntityId) {
          hitEntityId = resolved.hitEntityId;
          hitPoint = resolved.hitPoint;
        }
      }
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
  }, [resolveHit]);

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

      // Set orbit pivot to point under cursor (use screenToWorld, not full raycast)
      const app = appInstanceRef.current;
      if (app && !e.shiftKey) {
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          const worldPoint = app.viewport.screenToWorld(screenX, screenY);
          if (worldPoint) {
            const cam = app.viewport.camera as any;
            if (cam.setOrbitPivot) cam.setOrbitPivot(worldPoint);
          }
        }
      }
      return;
    }

    const app = appInstanceRef.current;
    const tool = app?.toolManager.getActiveTool();
    if (!tool) return;

    // Use lightweight path for select/paint/eraser (GPU pick + edge raycast on click only)
    const lightToolIds = ['tool.select', 'tool.paint', 'tool.eraser'];
    const isLightTool = lightToolIds.indexOf(tool.id) >= 0;
    const ev = isLightTool ? getToolEventLight(e) : getToolEvent(e);
    if (!ev) return;

    tool.onMouseDown(ev);

    // Skip expensive syncScene for tools that don't modify geometry
    if (isLightTool) {
      syncSelectionToUI();
      syncPreviews();
      updateState({
        vcbLabel: tool.getVCBLabel(),
        vcbValue: tool.getVCBValue(),
        statusText: tool.getStatusText(),
      });
    } else {
      syncAfterAction();
    }
  }, [getToolEvent, getToolEventLight, syncAfterAction, syncSelectionToUI, syncPreviews, updateState]);

  // Throttle mouse move for tool events to avoid overwhelming raycasting/snapping
  const lastMoveTimeRef = useRef(0);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const app = appInstanceRef.current;

    // Safety: if we think middle mouse is down but no buttons are pressed, reset
    if (middleMouseRef.current.active && e.buttons === 0) {
      middleMouseRef.current.active = false;
    }

    // Middle mouse orbit/pan — always immediate, no throttle
    if (middleMouseRef.current.active && app) {
      const dx = e.clientX - middleMouseRef.current.lastX;
      const dy = e.clientY - middleMouseRef.current.lastY;
      middleMouseRef.current.lastX = e.clientX;
      middleMouseRef.current.lastY = e.clientY;

      const t0 = performance.now();
      if (middleMouseRef.current.shift) {
        app.viewport.camera.pan(dx, dy);
      } else {
        app.viewport.camera.orbit(dx, dy);
      }
      const dt = performance.now() - t0;
      if (dt > 5) console.warn(`[orbit/pan] took ${dt.toFixed(1)}ms`);
      return;
    }

    // Throttle tool mouse move to ~60fps (16ms) to avoid queueing expensive
    // raycasts/snap checks faster than they can complete on large models
    const now = performance.now();
    if (now - lastMoveTimeRef.current < 16) return;
    lastMoveTimeRef.current = now;

    const tool = app?.toolManager.getActiveTool();
    if (!tool) return;

    // Determine whether this tool needs full raycast+snap on mouse move.
    // Only tools actively drawing/modifying geometry need it (e.g. line tool in 'drawing' phase).
    // Everything else uses GPU pick only to avoid 100ms+ raycasts on large models.
    const toolPhase = (tool as any).phase;
    const needsFullRaycast = toolPhase === 'active' || toolPhase === 'drawing';
    const ev = needsFullRaycast ? getToolEvent(e) : getToolEventGpuOnly(e);
    if (!ev) return;

    tool.onMouseMove(ev);

    // Sync scene on every mouse move for modify tools that move geometry
    // in active phase (Move/Rotate/Scale/Offset/PushPull).
    const geometryModifyTools = ['tool.move', 'tool.rotate', 'tool.scale', 'tool.offset', 'tool.pushpull'];
    if (app && geometryModifyTools.indexOf(tool.id) >= 0 && (tool as any).phase === 'active') {
      app.syncScene();
    }

    // Render live tool preview (rubber-band lines, rectangle outlines, etc.)
    syncPreviews();

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
  }, [getToolEvent, getToolEventGpuOnly, syncSelectionToUI, syncPreviews, updateState]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // Middle mouse release
    if (e.button === 1) {
      middleMouseRef.current.active = false;
      return;
    }

    const app = appInstanceRef.current;
    const tool = app?.toolManager.getActiveTool();
    if (!tool) return;

    const lightToolIds = ['tool.select', 'tool.paint', 'tool.eraser'];
    const isLightTool = lightToolIds.indexOf(tool.id) >= 0;
    const ev = isLightTool ? getToolEventLight(e) : getToolEvent(e);
    if (!ev) return;

    tool.onMouseUp(ev);
    setDragBox(null);

    if (isLightTool) {
      syncSelectionToUI();
      syncPreviews();
    } else {
      syncAfterAction();
    }
  }, [getToolEvent, getToolEventLight, syncAfterAction, syncSelectionToUI, syncPreviews]);

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
