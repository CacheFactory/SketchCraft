// @archigraph tool.scale
// Scale tool: select, click origin, drag to scale with live preview.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';

export class ScaleTool extends BaseTool {
  readonly id = 'tool.scale';
  readonly name = 'Scale';
  readonly icon = 'scale';
  readonly shortcut = 'S';
  readonly category = 'modify' as const;
  readonly cursor = 'nwse-resize';

  private center: Vec3 | null = null;
  private startDist = 1;
  private currentScale = 1;
  private vertexIds: string[] = [];
  private originalPositions = new Map<string, Vec3>();

  activate(): void {
    super.activate();
    this.reset();
    if (!this.document.selection.isEmpty) {
      this.gatherVertices();
      this.setStatus(`${this.vertexIds.length} vertices. Click scale origin.`);
    } else {
      this.setStatus('Select a face/edge, then click scale origin.');
    }
  }

  deactivate(): void {
    if (this.phase !== 'idle') { this.restoreOriginal(); this.abortTransaction(); }
    this.reset(); super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.resolvePoint(event) ?? this.screenToDrawingPlane(event);
    if (!point) return;

    if (this.phase === 'idle') {
      if (this.document.selection.isEmpty && event.hitEntityId) this.document.selection.select(event.hitEntityId);
      if (this.document.selection.isEmpty) { this.setStatus('Nothing to scale.'); return; }
      this.gatherVertices();
      this.center = point;
      this.startDist = 0;
      this.beginTransaction('Scale');
      this.saveOriginal();
      this.setPhase('drawing');
      this.setStatus('Drag to scale. Type value for exact factor.');
    } else if (this.phase === 'drawing') {
      this.commitTransaction(); this.reset();
      this.setStatus('Scale complete.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase !== 'drawing' || !this.center) return;
    const point = this.resolvePoint(event) ?? this.screenToDrawingPlane(event);
    if (!point) return;

    const dist = vec3.distance(point, this.center);
    if (this.startDist === 0) { this.startDist = Math.max(dist, 0.01); return; }

    this.currentScale = dist / this.startDist;
    this.setVCBValue(this.currentScale.toFixed(3));
    this.applyScale(this.currentScale);
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.phase !== 'idle') { this.restoreOriginal(); this.abortTransaction(); }
      this.reset(); this.setStatus('Scale cancelled.');
    }
  }

  onVCBInput(value: string): void {
    if (this.phase !== 'drawing') return;
    const factor = this.parseDistance(value);
    if (isNaN(factor) || factor <= 0) return;
    this.applyScale(factor);
    this.commitTransaction(); this.reset(); this.setStatus('Scale complete.');
  }

  getVCBLabel(): string { return this.phase === 'drawing' ? 'Factor' : ''; }
  getPreview(): ToolPreview | null { return null; }

  private reset(): void {
    this.center = null; this.startDist = 1; this.currentScale = 1;
    this.vertexIds = []; this.originalPositions.clear();
    this.setPhase('idle'); this.setVCBValue('');
  }

  private gatherVertices(): void {
    this.vertexIds = []; const seen = new Set<string>();
    for (const eid of this.resolveSelectedEntityIds()) {
      const f = this.document.geometry.getFace(eid);
      if (f) { for (const vid of f.vertexIds) if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); } continue; }
      const e = this.document.geometry.getEdge(eid);
      if (e) { for (const vid of [e.startVertexId, e.endVertexId]) if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); } }
    }
  }

  private saveOriginal(): void { for (const vid of this.vertexIds) { const v = this.document.geometry.getVertex(vid); if (v) this.originalPositions.set(vid, vec3.clone(v.position)); } }
  private restoreOriginal(): void { for (const [vid, p] of this.originalPositions) { const v = this.document.geometry.getVertex(vid); if (v) { v.position.x = p.x; v.position.y = p.y; v.position.z = p.z; } } }

  private applyScale(factor: number): void {
    if (!this.center) return;
    for (const [vid, orig] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid); if (!v) continue;
      const rel = vec3.sub(orig, this.center);
      const scaled = vec3.add(this.center, vec3.mul(rel, factor));
      v.position.x = scaled.x; v.position.y = scaled.y; v.position.z = scaled.z;
    }
  }
}
