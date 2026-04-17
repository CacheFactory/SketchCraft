// @archigraph tool.circle
// Circle tool: click center, move for radius, creates polygon approximation

import type { Vec3, Plane } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';
import { v4 as uuid } from 'uuid';

export class CircleTool extends BaseTool {
  readonly id = 'tool.circle';
  readonly name = 'Circle';
  readonly icon = 'circle';
  readonly shortcut = 'C';
  readonly category = 'draw' as const;
  readonly cursor = 'crosshair';

  private center: Vec3 | null = null;
  private drawPlane: Plane = { normal: { x: 0, y: 1, z: 0 }, distance: 0 };
  private segments = 24;
  private currentRadius = 0;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus(`Click to place center. Segments: ${this.segments}`);
  }

  deactivate(): void {
    if (this.phase !== 'idle') this.abortTransaction();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    if (this.phase === 'idle') {
      const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
      if (!point) return;

      this.center = point;
      this.beginTransaction('Draw Circle');
      this.drawPlane = this.getDrawingPlane(this.center);
      this.setPhase('drawing');
      this.setStatus('Move to set radius, then click. Arrow keys change plane.');
    } else if (this.phase === 'drawing') {
      this.createCircle(this.currentRadius);
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase !== 'drawing' || !this.center) return;
    const point = this.screenToDrawingPlane(event, this.center) ?? this.resolvePoint(event);
    if (!point) return;

    const projected = vec3.projectOnPlane(point, this.drawPlane);
    this.currentRadius = vec3.distance(this.center, projected);
    this.setVCBValue(this.currentRadius.toFixed(3));
  }

  onKeyDown(event: ToolKeyEvent): void {
    // Arrow keys change drawing plane
    if (this.handleArrowKeyPlane(event)) {
      if (this.center) {
        this.drawPlane = this.getDrawingPlane(this.center);
      }
      return;
    }

    if (event.key === 'Escape') {
      if (this.phase !== 'idle') this.abortTransaction();
      this.reset();
      this.setStatus(`Click to place center. Segments: ${this.segments}`);
    }
  }

  onVCBInput(value: string): void {
    const trimmed = value.trim();

    // Check if it's a segment count (e.g., "24s")
    if (trimmed.endsWith('s')) {
      const segs = parseInt(trimmed.slice(0, -1), 10);
      if (!isNaN(segs) && segs >= 3) {
        this.segments = segs;
        this.setStatus(`Segments set to ${this.segments}`);
        return;
      }
    }

    if (this.phase !== 'drawing' || !this.center) return;

    const radius = this.parseDistance(value);
    if (isNaN(radius) || radius <= 0) return;

    this.createCircle(radius);
  }

  getVCBLabel(): string {
    return this.phase === 'drawing' ? 'Radius' : 'Sides';
  }

  getPreview(): ToolPreview | null {
    if (this.phase !== 'drawing' || !this.center || this.currentRadius <= 0) return null;

    const normal = this.drawPlane.normal;
    let tangent: Vec3;
    if (Math.abs(normal.y) > 0.9) {
      tangent = vec3.normalize(vec3.cross(normal, { x: 1, y: 0, z: 0 }));
    } else {
      tangent = vec3.normalize(vec3.cross(normal, { x: 0, y: 1, z: 0 }));
    }
    const bitangent = vec3.normalize(vec3.cross(normal, tangent));

    const points: Vec3[] = [];
    for (let i = 0; i < this.segments; i++) {
      const angle = (2 * Math.PI * i) / this.segments;
      const offset = vec3.add(
        vec3.mul(tangent, Math.cos(angle) * this.currentRadius),
        vec3.mul(bitangent, Math.sin(angle) * this.currentRadius),
      );
      points.push(vec3.add(this.center, offset));
    }

    return { polygon: points };
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.center = null;
    this.currentRadius = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private createCircle(radius: number): void {
    if (!this.center || radius <= 0) return;

    const vertexIds: string[] = [];
    const normal = this.drawPlane.normal;

    // Compute local axes on the plane
    let tangent: Vec3;
    if (Math.abs(normal.y) > 0.9) {
      tangent = vec3.normalize(vec3.cross(normal, { x: 1, y: 0, z: 0 }));
    } else {
      tangent = vec3.normalize(vec3.cross(normal, { x: 0, y: 1, z: 0 }));
    }
    const bitangent = vec3.normalize(vec3.cross(normal, tangent));

    for (let i = 0; i < this.segments; i++) {
      const angle = (2 * Math.PI * i) / this.segments;
      const offset = vec3.add(
        vec3.mul(tangent, Math.cos(angle) * radius),
        vec3.mul(bitangent, Math.sin(angle) * radius),
      );
      const point = vec3.add(this.center, offset);
      const vertex = this.document.geometry.createVertex(point);
      vertexIds.push(vertex.id);
    }

    // Create edges with intersection detection, grouped as a curve
    const curveId = uuid();
    for (let i = 0; i < this.segments; i++) {
      const next = (i + 1) % this.segments;
      const edges = this.document.geometry.createEdgeWithIntersection(vertexIds[i], vertexIds[next]);
      for (const edge of edges) edge.curveId = curveId;
    }

    this.commitTransaction();
    this.reset();
    this.setStatus(`Circle created. Click to place center. Segments: ${this.segments}`);
  }
}
