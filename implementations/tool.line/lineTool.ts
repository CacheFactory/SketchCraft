// @archigraph tool.line
// Line drawing tool: click to place points, rubber-band preview, auto-face creation.
// Arrow keys lock to axis: Up=Y (vertical), Right=X (red), Left=Z (blue), Down=unlock.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';

export class LineTool extends BaseTool {
  readonly id = 'tool.line';
  readonly name = 'Line';
  readonly icon = 'pencil';
  readonly shortcut = 'L';
  readonly category = 'draw' as const;
  readonly cursor = 'crosshair';

  private points: Vec3[] = [];
  private vertexIds: string[] = [];
  private currentPoint: Vec3 | null = null;
  private lastScreenX = 0;
  private lastScreenY = 0;
  /** Axis lock: 'x' | 'y' | 'z' | null */
  private axisLock: 'x' | 'y' | 'z' | null = null;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place first point. Arrow keys lock to axis.');
  }

  deactivate(): void {
    if (this.points.length > 1) {
      if (this.vertexIds.length >= 2) {
        this.document.geometry.splitFaceWithPath(this.vertexIds);
      }
      this.commitTransaction();
    } else if (this.points.length === 1) {
      this.abortTransaction();
    }
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    const rawPoint = this.getDrawPoint(event);
    if (!rawPoint) return;
    const point = this.applyAxisLock(rawPoint);

    if (this.phase === 'idle') {
      this.beginTransaction('Draw Line');
      const vertex = this.findOrCreateVertex(point);
      this.points.push(point);
      this.vertexIds.push(vertex.id);
      this.setPhase('drawing');
      this.axisLock = null;
      this.setStatus('Click next point. Arrow keys: Up=Y, Right=X, Left=Z, Down=free.');
    } else if (this.phase === 'drawing') {
      const vertex = this.findOrCreateVertex(point);
      this.vertexIds.push(vertex.id);

      const prevId = this.vertexIds[this.vertexIds.length - 2];
      this.document.geometry.createEdgeWithAutoFace(prevId, vertex.id);

      this.points.push(point);
      this.axisLock = null; // Reset lock after placing point

      if (this.points.length >= 3 && vec3.distance(point, this.points[0]) < 0.01) {
        this.tryCreateFace();
        this.commitTransaction();
        this.reset();
        this.setStatus('Loop closed. Click to start a new line.');
        return;
      }

      this.updateVCBFromSegment();
      this.setStatus('Click next point. Arrow keys: Up=Y, Right=X, Left=Z, Down=free.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    this.lastScreenX = event.screenX;
    this.lastScreenY = event.screenY;

    const rawPoint = this.getDrawPoint(event);
    if (!rawPoint) return;

    this.currentPoint = this.applyAxisLock(rawPoint);

    if (this.phase === 'drawing' && this.points.length > 0) {
      const lastPoint = this.points[this.points.length - 1];
      const dist = vec3.distance(lastPoint, this.currentPoint);
      this.setVCBValue(dist.toFixed(3));
    }
  }

  onMouseUp(_event: ToolMouseEvent): void {}

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.phase === 'drawing' && this.points.length > 1) {
        this.commitTransaction();
      } else if (this.phase === 'drawing') {
        this.abortTransaction();
      }
      this.reset();
      this.setStatus('Click to place first point.');
      return;
    }

    if (event.key === 'Enter') {
      if (this.phase === 'drawing' && this.points.length > 1) {
        this.commitTransaction();
      }
      this.reset();
      this.setStatus('Click to place first point.');
      return;
    }

    // Arrow keys lock to axis
    if (event.key === 'ArrowUp') {
      this.axisLock = this.axisLock === 'y' ? null : 'y';
    } else if (event.key === 'ArrowRight') {
      this.axisLock = this.axisLock === 'x' ? null : 'x';
    } else if (event.key === 'ArrowLeft') {
      this.axisLock = this.axisLock === 'z' ? null : 'z';
    } else if (event.key === 'ArrowDown') {
      this.axisLock = null;
    } else {
      return; // Not an arrow key
    }

    if (this.axisLock) {
      const axisNames = { x: 'Red (X)', y: 'Green (Y) — vertical', z: 'Blue (Z)' };
      this.setStatus(`Locked to ${axisNames[this.axisLock]} axis.`);
    } else {
      this.setStatus('Axis unlocked. Free movement.');
    }

    // Immediately recompute currentPoint from stored screen position
    if (this.points.length > 0 && this.lastScreenX > 0) {
      const anchor = this.points[this.points.length - 1];
      const ray = this.viewport.camera.screenToRay(
        this.lastScreenX, this.lastScreenY,
        this.viewport.getWidth(), this.viewport.getHeight(),
      );

      if (this.axisLock) {
        this.currentPoint = this.projectRayOntoAxis(ray, anchor, this.axisLock);
      } else {
        // Unlock — project onto ground plane
        const n = { x: 0, y: 1, z: 0 };
        const denom = vec3.dot(ray.direction, n);
        if (Math.abs(denom) > 1e-10) {
          const t = -ray.origin.y / denom;
          if (t > 0) {
            this.currentPoint = vec3.add(ray.origin, vec3.mul(ray.direction, t));
          }
        }
      }
    }
  }

  onVCBInput(value: string): void {
    if (this.phase !== 'drawing' || this.points.length === 0) return;

    const lastPoint = this.points[this.points.length - 1];
    const parts = this.parseDimensions(value);

    let targetPoint: Vec3;

    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      targetPoint = vec3.add(lastPoint, vec3.create(parts[0], parts[1], parts[2]));
    } else if (parts.length === 2 && parts.every(n => !isNaN(n))) {
      targetPoint = vec3.add(lastPoint, vec3.create(parts[0], 0, parts[1]));
    } else {
      const dist = this.parseDistance(value);
      if (isNaN(dist)) return;
      if (!this.currentPoint) return;
      const dir = vec3.normalize(vec3.sub(this.currentPoint, lastPoint));
      if (vec3.lengthSq(dir) < 1e-10) return;
      targetPoint = vec3.add(lastPoint, vec3.mul(dir, dist));
    }

    const vertex = this.findOrCreateVertex(targetPoint);
    this.vertexIds.push(vertex.id);
    const prevId = this.vertexIds[this.vertexIds.length - 2];
    this.document.geometry.createEdgeWithAutoFace(prevId, vertex.id);
    this.points.push(targetPoint);

    if (this.points.length >= 3 && vec3.distance(targetPoint, this.points[0]) < 0.01) {
      this.tryCreateFace();
      this.commitTransaction();
      this.reset();
      this.setStatus('Loop closed.');
    } else {
      this.updateVCBFromSegment();
    }
  }

  getVCBLabel(): string {
    return this.phase === 'drawing' ? 'Length' : '';
  }

  getPreview(): ToolPreview | null {
    if (this.phase !== 'drawing' || this.points.length === 0 || !this.currentPoint) return null;
    const lastPoint = this.points[this.points.length - 1];
    return { lines: [{ from: lastPoint, to: this.currentPoint }] };
  }

  // ── Private ────────────────────────────────────────────

  /**
   * Apply axis lock: constrain the point to move only along the locked axis
   * from the last placed point.
   */
  private applyAxisLock(point: Vec3): Vec3 {
    if (!this.axisLock || this.points.length === 0) return point;
    const last = this.points[this.points.length - 1];
    switch (this.axisLock) {
      case 'x': return { x: point.x, y: last.y, z: last.z };
      case 'y': return { x: last.x, y: point.y, z: last.z };
      case 'z': return { x: last.x, y: last.y, z: point.z };
    }
  }

  /**
   * Project a camera ray onto an axis line from an anchor point.
   * Returns the closest point on the axis to the ray.
   */
  private projectRayOntoAxis(ray: { origin: Vec3; direction: Vec3 }, anchor: Vec3, axis: 'x' | 'y' | 'z'): Vec3 {
    const axisDir: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } :
                          axis === 'y' ? { x: 0, y: 1, z: 0 } :
                                         { x: 0, y: 0, z: 1 };

    // Closest point between two lines: ray and axis line through anchor
    const w = vec3.sub(anchor, ray.origin);
    const a = vec3.dot(ray.direction, ray.direction);
    const b = vec3.dot(ray.direction, axisDir);
    const c = vec3.dot(axisDir, axisDir);
    const d = vec3.dot(ray.direction, w);
    const e = vec3.dot(axisDir, w);

    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-10) return anchor; // Parallel

    const t = (b * e - c * d) / denom;
    // s gives us the parameter on the axis line
    const s = (a * e - b * d) / denom;

    return vec3.add(anchor, vec3.mul(axisDir, s));
  }

  private getDrawPoint(event: ToolMouseEvent): Vec3 | null {
    const anchor = this.points.length > 0 ? this.points[this.points.length - 1] : undefined;

    // If axis-locked, project the camera ray onto the locked axis
    if (this.axisLock && anchor) {
      const ray = this.viewport.camera.screenToRay(
        event.screenX, event.screenY,
        this.viewport.getWidth(), this.viewport.getHeight(),
      );
      return this.projectRayOntoAxis(ray, anchor, this.axisLock);
    }

    // Use snapped worldPoint if available (includes vertices AND midpoints)
    if (event.worldPoint) return event.worldPoint;

    // Fallback: raycast onto drawing plane
    const planePoint = this.screenToDrawingPlane(event, anchor);
    if (planePoint) return planePoint;

    return null;
  }

  private findOrCreateVertex(point: Vec3): { id: string } {
    const SNAP_DIST = 0.01;
    const mesh = this.document.geometry.getMesh();
    for (const [, v] of mesh.vertices) {
      if (vec3.distance(v.position, point) < SNAP_DIST) {
        return { id: v.id };
      }
    }
    return this.document.geometry.createVertex(point);
  }

  private reset(): void {
    this.points = [];
    this.vertexIds = [];
    this.currentPoint = null;
    this.axisLock = null;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private updateVCBFromSegment(): void {
    if (this.points.length >= 2) {
      const a = this.points[this.points.length - 2];
      const b = this.points[this.points.length - 1];
      this.setVCBValue(vec3.distance(a, b).toFixed(3));
    }
  }

  private tryCreateFace(): void {
    if (this.vertexIds.length < 3) return;
    const uniqueIds = this.vertexIds.slice(0, -1);
    if (this.document.geometry.checkCoplanar(uniqueIds)) {
      try {
        this.document.geometry.createFace(uniqueIds);
      } catch {}
    }
  }
}
