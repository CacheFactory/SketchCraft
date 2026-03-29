// @archigraph tool.rotate
// Rotate tool: select, click center, click start angle, drag to rotate with live preview.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';

export class RotateTool extends BaseTool {
  readonly id = 'tool.rotate';
  readonly name = 'Rotate';
  readonly icon = 'rotate';
  readonly shortcut = 'Q';
  readonly category = 'modify' as const;
  readonly cursor = 'crosshair';

  private center: Vec3 | null = null;
  private startAngleRef: Vec3 | null = null;
  private currentAngle = 0;
  private step: 0 | 1 | 2 = 0;
  private vertexIds: string[] = [];
  private originalPositions = new Map<string, Vec3>();
  private rotationAxis: Vec3 = { x: 0, y: 1, z: 0 };

  activate(): void {
    super.activate();
    this.reset();
    if (!this.document.selection.isEmpty) {
      this.gatherVertices();
      this.setStatus(`${this.vertexIds.length} vertices. Click rotation center.`);
    } else {
      this.setStatus('Select a face/edge, then click rotation center.');
    }
  }

  deactivate(): void {
    if (this.step > 0) { this.restoreOriginal(); this.abortTransaction(); }
    this.reset(); super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    if (this.step === 0) {
      if (this.document.selection.isEmpty && event.hitEntityId) this.document.selection.select(event.hitEntityId);
      if (this.document.selection.isEmpty) { this.setStatus('Nothing to rotate.'); return; }
      this.gatherVertices();
      this.center = point;
      this.beginTransaction('Rotate');
      this.saveOriginal();
      this.step = 1; this.setPhase('drawing');
      this.setStatus('Click to set start angle reference.');
    } else if (this.step === 1) {
      this.startAngleRef = point;
      this.step = 2;
      this.setStatus('Drag to rotate. Type degrees for exact angle.');
    } else if (this.step === 2) {
      this.commitTransaction(); this.reset();
      this.setStatus('Rotation complete.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.step !== 2 || !this.center || !this.startAngleRef) return;
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    const v1 = vec3.normalize(vec3.sub(this.startAngleRef, this.center));
    const v2 = vec3.normalize(vec3.sub(point, this.center));
    const dot = Math.max(-1, Math.min(1, vec3.dot(v1, v2)));
    const cross = vec3.cross(v1, v2);
    const sign = vec3.dot(cross, this.rotationAxis) >= 0 ? 1 : -1;
    this.currentAngle = sign * Math.acos(dot);
    this.setVCBValue(`${(this.currentAngle * 180 / Math.PI).toFixed(1)}°`);
    this.applyRotation(this.currentAngle);
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.step > 0) { this.restoreOriginal(); this.abortTransaction(); }
      this.reset(); this.setStatus('Rotation cancelled.');
    }
  }

  onVCBInput(value: string): void {
    if (this.step !== 2) return;
    const deg = this.parseDistance(value.replace('°', ''));
    if (isNaN(deg)) return;
    this.applyRotation(deg * Math.PI / 180);
    this.commitTransaction(); this.reset(); this.setStatus('Rotation complete.');
  }

  getVCBLabel(): string { return this.step === 2 ? 'Angle' : ''; }
  getPreview(): ToolPreview | null { return null; }

  private reset(): void {
    this.center = null; this.startAngleRef = null; this.currentAngle = 0;
    this.step = 0; this.vertexIds = []; this.originalPositions.clear();
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

  private applyRotation(angle: number): void {
    if (!this.center) return;
    const cos = Math.cos(angle), sin = Math.sin(angle), ax = this.rotationAxis;
    for (const [vid, orig] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid); if (!v) continue;
      const rel = vec3.sub(orig, this.center);
      const d = vec3.dot(rel, ax), cr = vec3.cross(ax, rel);
      const rot = vec3.add(vec3.add(vec3.mul(rel, cos), vec3.mul(cr, sin)), vec3.mul(ax, d * (1 - cos)));
      const fin = vec3.add(this.center, rot);
      v.position.x = fin.x; v.position.y = fin.y; v.position.z = fin.z;
    }
  }
}
