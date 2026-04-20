// @archigraph tool.paint
// Paint bucket tool: apply materials to faces

import type { ToolMouseEvent, ToolKeyEvent, ToolEventNeeds } from '../../src/core/interfaces';
import { BaseTool } from '../tool.select/BaseTool';

export class PaintTool extends BaseTool {
  readonly id = 'tool.paint';
  readonly name = 'Paint Bucket';
  readonly icon = 'paint-bucket';
  readonly shortcut = 'B';
  readonly category = 'modify' as const;
  readonly cursor = 'pointer';

  activeMaterialId: string | null = null;

  activate(): void {
    super.activate();
    this.setStatus('Click a face to paint. Shift+click to sample. Alt+click to fill matching.');
  }

  deactivate(): void {
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    const faceId = event.hitEntityId;
    if (!faceId) return;
    const face = this.document.geometry.getFace(faceId);
    if (!face) return;

    if (event.shiftKey) {
      // Sample material from face
      const mat = this.document.materials.getFaceMaterial(faceId);
      this.activeMaterialId = mat.id;
      this.setStatus(`Sampled material: ${mat.name}`);
      return;
    }

    if (!this.activeMaterialId) {
      this.setStatus('No material selected. Shift+click to sample a material first.');
      return;
    }

    this.beginTransaction('Paint');

    if (event.altKey) {
      // Apply to all faces with the same current material
      const currentMat = this.document.materials.getFaceMaterial(faceId);
      const allFaces = this.document.geometry.getMesh().faces;
      allFaces.forEach((f, id) => {
        const fMat = this.document.materials.getFaceMaterial(id);
        if (fMat.id === currentMat.id) {
          this.document.materials.applyToFace(id, this.activeMaterialId!);
        }
      });
    } else {
      // Apply to single face
      this.document.materials.applyToFace(faceId, this.activeMaterialId);
    }

    this.commitTransaction();
  }

  onMouseMove(event: ToolMouseEvent): void {
    // Highlight face under cursor
    if (event.hitEntityId) {
      const face = this.document.geometry.getFace(event.hitEntityId);
      if (face) {
        this.document.selection.setPreSelection(event.hitEntityId);
        return;
      }
    }
    this.document.selection.setPreSelection(null);
  }

  getVCBLabel(): string { return ''; }

  getEventNeeds(): ToolEventNeeds {
    return { snap: false, raycast: false, edgeRaycast: true, liveSyncOnMove: false, mutatesOnClick: true };
  }
}
