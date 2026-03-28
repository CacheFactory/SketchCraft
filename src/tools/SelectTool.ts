// @archigraph tool.select
// Selection tool: single-click selects entity under cursor (point pick).
// Uses hitEntityId from event (raycasted by ViewportCanvas) for reliable detection.

import type { ToolMouseEvent, ToolKeyEvent } from '../core/interfaces';
import { BaseTool } from './BaseTool';

export class SelectTool extends BaseTool {
  readonly id = 'tool.select';
  readonly name = 'Select';
  readonly icon = 'cursor';
  readonly shortcut = 'Space';
  readonly category = 'modify' as const;
  readonly cursor = 'default';

  private dragStart: { x: number; y: number } | null = null;
  private currentDrag: { x: number; y: number } | null = null;
  private isDragging = false;
  private lastClickTime = 0;
  private readonly DOUBLE_CLICK_MS = 400;
  private readonly DRAG_THRESHOLD = 8;

  /** Returns the drag box rectangle for visual rendering, or null if not dragging. */
  getDragBox(): { x: number; y: number; width: number; height: number; mode: 'window' | 'crossing' } | null {
    if (!this.isDragging || !this.dragStart || !this.currentDrag) return null;
    const x = Math.min(this.dragStart.x, this.currentDrag.x);
    const y = Math.min(this.dragStart.y, this.currentDrag.y);
    const width = Math.abs(this.currentDrag.x - this.dragStart.x);
    const height = Math.abs(this.currentDrag.y - this.dragStart.y);
    const mode = this.currentDrag.x >= this.dragStart.x ? 'window' : 'crossing';
    return { x, y, width, height, mode };
  }

  private setCursorPointer(isPointer: boolean): void {
    const container = document.querySelector('.viewport-container') as HTMLElement;
    if (container) {
      container.style.cursor = isPointer ? 'pointer' : 'default';
    }
  }

  activate(): void {
    super.activate();
    this.setStatus('Click to select. Shift+click to add/remove.');
  }

  deactivate(): void {
    super.deactivate();
    this.dragStart = null;
    this.currentDrag = null;
    this.isDragging = false;
    this.setCursorPointer(false);
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    this.dragStart = { x: event.screenX, y: event.screenY };
    this.isDragging = false;
    this.setPhase('active');

    // Double-click detection
    const now = Date.now();
    const isDoubleClick = (now - this.lastClickTime) < this.DOUBLE_CLICK_MS;
    this.lastClickTime = now;

    if (isDoubleClick && event.hitEntityId) {
      const entity = this.document.scene.getEntity(event.hitEntityId);
      if (entity && (entity.type === 'group' || entity.type === 'component_instance')) {
        this.document.scene.enterGroup(event.hitEntityId);
        this.setStatus('Editing group. Press Escape to exit.');
        this.setPhase('idle');
        this.dragStart = null;
        return;
      }
    }

    // Instant point-pick using the pre-computed raycast hit
    if (event.hitEntityId) {
      if (event.shiftKey) {
        this.document.selection.toggle(event.hitEntityId);
      } else {
        this.document.selection.select(event.hitEntityId);
      }
      const count = this.document.selection.count;
      if (count === 1) {
        this.setStatus(`Selected ${this.getEntityTypeLabel(event.hitEntityId)}. Shift+click to add more.`);
      } else {
        this.setStatus(`${count} entities selected. Shift+click to add/remove.`);
      }
    } else if (!event.shiftKey) {
      this.document.selection.clear();
      this.setStatus('Click to select. Shift+click to add/remove.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase === 'idle') {
      // Pre-selection highlight + cursor change
      if (event.hitEntityId) {
        this.document.selection.setPreSelection(event.hitEntityId);
        this.setCursorPointer(true);
      } else {
        this.document.selection.setPreSelection(null);
        this.setCursorPointer(false);
      }
      return;
    }

    // Check if drag started (for box select)
    if (this.dragStart && !this.isDragging) {
      const dx = event.screenX - this.dragStart.x;
      const dy = event.screenY - this.dragStart.y;
      if (Math.abs(dx) > this.DRAG_THRESHOLD || Math.abs(dy) > this.DRAG_THRESHOLD) {
        this.isDragging = true;
        this.setPhase('dragging');
        this.setStatus('Release to complete box selection.');
      }
    }

    // Update drag box position
    if (this.isDragging && this.dragStart) {
      this.currentDrag = { x: event.screenX, y: event.screenY };
    }
  }

  onMouseUp(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    if (this.isDragging && this.dragStart) {
      const x = Math.min(this.dragStart.x, event.screenX);
      const y = Math.min(this.dragStart.y, event.screenY);
      const width = Math.abs(event.screenX - this.dragStart.x);
      const height = Math.abs(event.screenY - this.dragStart.y);

      if (!event.shiftKey) {
        this.document.selection.clear();
      }

      // Box select: project all entity centers to screen and check containment
      const vw = this.viewport.getWidth();
      const vh = this.viewport.getHeight();
      const mesh = this.document.geometry.getMesh();

      // Check faces
      for (const [faceId, face] of mesh.faces) {
        const verts = face.vertexIds.map(vid => mesh.vertices.get(vid)).filter(Boolean);
        if (verts.length === 0) continue;
        let cx = 0, cy = 0, cz = 0;
        for (const v of verts) { cx += v!.position.x; cy += v!.position.y; cz += v!.position.z; }
        const center = { x: cx / verts.length, y: cy / verts.length, z: cz / verts.length };
        const screen = this.viewport.camera.worldToScreen(center, vw, vh);
        if (screen.x >= x && screen.x <= x + width && screen.y >= y && screen.y <= y + height) {
          this.document.selection.add(faceId);
        }
      }

      // Check edges
      for (const [edgeId, edge] of mesh.edges) {
        const v1 = mesh.vertices.get(edge.startVertexId);
        const v2 = mesh.vertices.get(edge.endVertexId);
        if (!v1 || !v2) continue;
        const mid = { x: (v1.position.x + v2.position.x) / 2, y: (v1.position.y + v2.position.y) / 2, z: (v1.position.z + v2.position.z) / 2 };
        const screen = this.viewport.camera.worldToScreen(mid, vw, vh);
        if (screen.x >= x && screen.x <= x + width && screen.y >= y && screen.y <= y + height) {
          this.document.selection.add(edgeId);
        }
      }

      this.setStatus(`${this.document.selection.count} entities selected.`);
    }

    this.dragStart = null;
    this.currentDrag = null;
    this.isDragging = false;
    this.setPhase('idle');
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.document.scene.editingContext.activeGroupId) {
        this.document.scene.exitGroup();
        this.setStatus('Exited group editing.');
      } else {
        this.document.selection.clear();
        this.setStatus('Selection cleared.');
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      const ids = Array.from(this.document.selection.state.entityIds);
      if (ids.length > 0) {
        this.beginTransaction('Delete');
        for (const id of ids) {
          this.document.geometry.deleteFace(id);
          this.document.geometry.deleteEdge(id);
        }
        this.document.selection.clear();
        this.commitTransaction();
        this.setStatus(`Deleted ${ids.length} entities.`);
      }
    }
  }

  getVCBLabel(): string { return ''; }

  private getEntityTypeLabel(entityId: string): string {
    if (this.document.geometry.getFace(entityId)) return 'face';
    if (this.document.geometry.getEdge(entityId)) return 'edge';
    const entity = this.document.scene.getEntity(entityId);
    if (entity) return entity.type;
    return 'entity';
  }
}
