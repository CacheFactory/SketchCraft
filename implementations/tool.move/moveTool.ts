// @archigraph tool.move
// Move tool: select face/edge, click origin, drag to destination with live preview.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview, ToolEventNeeds } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';

export class MoveTool extends BaseTool {
  readonly id = 'tool.move';
  readonly name = 'Move';
  readonly icon = 'move';
  readonly shortcut = 'M';
  readonly category = 'modify' as const;
  readonly cursor = 'move';

  private origin: Vec3 | null = null;
  private currentDest: Vec3 | null = null;
  private isCopy = false;
  private vertexIds: string[] = []; // Vertices to move
  private originalPositions: Map<string, Vec3> = new Map();

  activate(): void {
    super.activate();
    this.reset();
    // If something already selected, use it
    if (!this.document.selection.isEmpty) {
      this.gatherVertices();
      this.setStatus(`${this.vertexIds.length} vertices ready. Click move origin.`);
    } else {
      this.setStatus('Select a face/edge, then click move origin.');
    }
  }

  deactivate(): void {
    if (this.phase !== 'idle') {
      this.restoreOriginalPositions();
      this.abortTransaction();
    }
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    if (this.phase === 'idle') {
      // Auto-select if nothing selected
      if (this.document.selection.isEmpty && event.hitEntityId) {
        this.document.selection.select(event.hitEntityId);
      }
      if (this.document.selection.isEmpty) {
        this.setStatus('Nothing to move. Click on a face or edge first.');
        return;
      }

      this.gatherVertices();
      if (this.vertexIds.length === 0) {
        this.setStatus('No movable vertices found.');
        return;
      }

      const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
      if (!point) return;

      this.origin = point;
      this.isCopy = event.ctrlKey;
      this.saveOriginalPositions();
      this.beginTransaction(this.isCopy ? 'Copy' : 'Move', [...this.originalPositions.keys()]);
      this.setPhase('drawing');
      this.setStatus(`Drag to destination. ${this.isCopy ? '(Copy)' : ''}`);
    } else if (this.phase === 'drawing') {
      // Commit the move
      this.commitTransaction();
      this.reset();
      this.setStatus('Move complete. Select and click to move again.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase !== 'drawing' || !this.origin) return;

    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    this.currentDest = point;
    const offset = vec3.sub(point, this.origin);
    this.setVCBValue(this.formatDist(vec3.length(offset)));

    // Live preview: move vertices to new positions
    this.applyOffset(offset);
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.phase !== 'idle') {
        this.restoreOriginalPositions();
        this.abortTransaction();
      }
      this.reset();
      this.setStatus('Move cancelled.');
    }
  }

  onVCBInput(value: string): void {
    if (this.phase !== 'drawing' || !this.origin || !this.currentDest) return;
    const dist = this.parseDistance(value);
    if (isNaN(dist)) return;

    const dir = vec3.normalize(vec3.sub(this.currentDest, this.origin));
    const offset = vec3.mul(dir, dist);
    this.applyOffset(offset);
    this.commitTransaction();
    this.reset();
    this.setStatus('Move complete.');
  }

  getVCBLabel(): string { return this.phase === 'drawing' ? 'Distance' : ''; }

  getEventNeeds(): ToolEventNeeds {
    const isActive = this.phase === 'active' || this.phase === 'drawing';
    return { snap: isActive, raycast: isActive, edgeRaycast: false, liveSyncOnMove: isActive, mutatesOnClick: true };
  }

  getPreview(): ToolPreview | null {
    if (this.phase !== 'drawing' || !this.origin || !this.currentDest) return null;
    return { lines: [{ from: this.origin, to: this.currentDest }] };
  }

  private reset(): void {
    this.origin = null;
    this.currentDest = null;
    this.isCopy = false;
    this.vertexIds = [];
    this.originalPositions.clear();
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private gatherVertices(): void {
    this.vertexIds = [];
    const seen = new Set<string>();
    for (const entityId of this.resolveSelectedEntityIds()) {
      const face = this.document.geometry.getFace(entityId);
      if (face) {
        for (const vid of face.vertexIds) {
          if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); }
        }
        continue;
      }
      const edge = this.document.geometry.getEdge(entityId);
      if (edge) {
        if (!seen.has(edge.startVertexId)) { seen.add(edge.startVertexId); this.vertexIds.push(edge.startVertexId); }
        if (!seen.has(edge.endVertexId)) { seen.add(edge.endVertexId); this.vertexIds.push(edge.endVertexId); }
      }
    }
  }

  private saveOriginalPositions(): void {
    this.originalPositions.clear();
    for (const vid of this.vertexIds) {
      const v = this.document.geometry.getVertex(vid);
      if (v) this.originalPositions.set(vid, vec3.clone(v.position));
    }
  }

  private restoreOriginalPositions(): void {
    for (const [vid, origPos] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid);
      if (v) { v.position.x = origPos.x; v.position.y = origPos.y; v.position.z = origPos.z; }
    }
  }

  private applyOffset(offset: Vec3): void {
    for (const [vid, origPos] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid);
      if (v) {
        v.position.x = origPos.x + offset.x;
        v.position.y = origPos.y + offset.y;
        v.position.z = origPos.z + offset.z;
      }
    }
    this._dirtyVertexIds = this.vertexIds;
  }
}
