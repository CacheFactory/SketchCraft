// @archigraph tool.polygon
// Polygon tool: click center, move for radius, creates regular polygon. Arrow keys change plane.

import type { Vec3, Plane } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool, DRAWING_PLANES } from '../tool.select/BaseTool';

export class PolygonTool extends BaseTool {
  readonly id = 'tool.polygon';
  readonly name = 'Polygon';
  readonly icon = 'hexagon';
  readonly shortcut = 'G';
  readonly category = 'draw' as const;
  readonly cursor = 'crosshair';

  private center: Vec3 | null = null;
  private drawPlane: Plane = { normal: { x: 0, y: 1, z: 0 }, distance: 0 };
  private sides = 6;
  private currentRadius = 0;
  private lastScreenX = 0;
  private lastScreenY = 0;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus(`Click to place center. Sides: ${this.sides}. Arrow keys change plane.`);
  }

  deactivate(): void {
    if (this.phase !== 'idle') this.abortTransaction();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    this.lastScreenX = event.screenX;
    this.lastScreenY = event.screenY;

    if (this.phase === 'idle') {
      const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
      if (!point) return;
      this.center = point;
      this.beginTransaction('Draw Polygon');
      this.drawPlane = this.getDrawingPlane(this.center);
      this.setPhase('drawing');
      this.setStatus('Move to set radius, then click. Arrow keys change plane.');
    } else if (this.phase === 'drawing') {
      this.createPolygon(this.currentRadius);
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase !== 'drawing' || !this.center) return;
    this.lastScreenX = event.screenX;
    this.lastScreenY = event.screenY;

    const point = this.screenToDrawingPlane(event, this.center) ?? this.resolvePoint(event);
    if (!point) return;

    const projected = vec3.projectOnPlane(point, this.drawPlane);
    this.currentRadius = vec3.distance(this.center, projected);
    this.setVCBValue(this.formatDist(this.currentRadius));
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.phase !== 'idle') this.abortTransaction();
      this.reset();
      this.setStatus(`Click to place center. Sides: ${this.sides}. Arrow keys change plane.`);
      return;
    }
    if (this.handleArrowKeyPlane(event)) {
      if (this.center) this.drawPlane = this.getDrawingPlane(this.center);
      const info = DRAWING_PLANES[this.drawingPlaneAxis];
      this.setStatus(`Plane: ${info.label}. Move to set radius.`);
    }
  }

  onVCBInput(value: string): void {
    const trimmed = value.trim();
    if (trimmed.endsWith('s')) {
      const s = parseInt(trimmed.slice(0, -1), 10);
      if (!isNaN(s) && s >= 3) { this.sides = s; this.setStatus(`Sides: ${this.sides}`); return; }
    }
    if (this.phase !== 'drawing' || !this.center) return;
    const radius = this.parseDistance(value);
    if (isNaN(radius) || radius <= 0) return;
    this.createPolygon(radius);
  }

  getVCBLabel(): string {
    return this.phase === 'drawing' ? 'Radius' : 'Sides';
  }

  getPreview(): ToolPreview | null {
    if (this.phase !== 'drawing' || !this.center || this.currentRadius <= 0) return null;
    return { polygon: this.computePoints(this.currentRadius) };
  }

  private reset(): void {
    this.center = null;
    this.currentRadius = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private computePoints(radius: number): Vec3[] {
    if (!this.center) return [];
    const normal = this.drawPlane.normal;
    let tangent: Vec3;
    if (Math.abs(normal.y) > 0.9) {
      tangent = vec3.normalize(vec3.cross(normal, { x: 1, y: 0, z: 0 }));
    } else {
      tangent = vec3.normalize(vec3.cross(normal, { x: 0, y: 1, z: 0 }));
    }
    const bitangent = vec3.normalize(vec3.cross(normal, tangent));

    const points: Vec3[] = [];
    for (let i = 0; i < this.sides; i++) {
      const angle = (2 * Math.PI * i) / this.sides;
      const offset = vec3.add(
        vec3.mul(tangent, Math.cos(angle) * radius),
        vec3.mul(bitangent, Math.sin(angle) * radius),
      );
      points.push(vec3.add(this.center, offset));
    }
    return points;
  }

  private createPolygon(radius: number): void {
    if (!this.center || radius <= 0) return;

    const points = this.computePoints(radius);
    const vertexIds: string[] = [];
    for (const p of points) {
      const v = this.document.geometry.createVertex(p);
      vertexIds.push(v.id);
    }
    for (let i = 0; i < this.sides; i++) {
      const next = (i + 1) % this.sides;
      this.document.geometry.createEdge(vertexIds[i], vertexIds[next]);
    }
    this.document.geometry.createFace(vertexIds);

    this.commitTransaction();
    this.reset();
    this.setStatus(`Polygon created. Sides: ${this.sides}. Arrow keys change plane.`);
  }
}
