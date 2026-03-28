// @archigraph tool.zoom
// Zoom tool: drag up/down to zoom, shift+click for zoom extents

import type { ToolMouseEvent } from '../core/interfaces';
import { BaseTool } from './BaseTool';

export class ZoomTool extends BaseTool {
  readonly id = 'tool.zoom';
  readonly name = 'Zoom';
  readonly icon = 'zoom-in';
  readonly shortcut = 'Z';
  readonly category = 'navigate' as const;
  readonly cursor = 'zoom-in';

  private lastY = 0;

  activate(): void {
    super.activate();
    this.setStatus('Drag up/down to zoom. Shift+click for Zoom Extents.');
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    if (event.shiftKey) {
      // Zoom extents
      const bbox = this.document.geometry.getBoundingBox();
      this.viewport.camera.fitToBox(bbox);
      this.setStatus('Zoomed to extents.');
      return;
    }

    this.lastY = event.screenY;
    this.setPhase('dragging');
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase !== 'dragging') return;

    const dy = event.screenY - this.lastY;
    this.lastY = event.screenY;

    // Negative dy = dragging up = zoom in
    this.viewport.camera.zoom(-dy * 0.5);
  }

  onMouseUp(_event: ToolMouseEvent): void {
    this.setPhase('idle');
  }

  getVCBLabel(): string { return ''; }
}
