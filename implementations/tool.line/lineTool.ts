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
  /** Whether the current point is parallel-snapped */
  private parallelSnapped = false;
  /** Guide line ID for parallel snap visualization */
  private static readonly PARALLEL_GUIDE_ID = 'parallel-snap-guide';

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place first point. Arrow keys lock to axis.');
  }

  deactivate(): void {
    if (this.points.length > 1) {
      // createEdgeWithIntersection already handles face splitting via autoCreateFaces
      this.commitTransaction();
    } else if (this.points.length === 1) {
      this.abortTransaction();
    }
    this.hideParallelGuide();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    const rawPoint = this.getDrawPoint(event);
    if (!rawPoint) return;
    let point = this.applyAxisLock(rawPoint);

    // Apply parallel snap on click (matches the constraint shown in onMouseMove)
    if (this.phase === 'drawing' && this.points.length > 0 && !this.axisLock) {
      const anchor = this.points[this.points.length - 1];
      const result = this.tryParallelSnap(anchor, point);
      if (result) {
        point = result.snappedPoint;
      }
    }

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
      const prevId = this.vertexIds[this.vertexIds.length - 1];

      // Guard: don't create zero-length edge (clicked same point twice)
      if (vertex.id === prevId) return;

      this.vertexIds.push(vertex.id);

      try {
        this.document.geometry.createEdgeWithIntersection(prevId, vertex.id);
      } catch {
        // Edge creation failed (degenerate) — remove the vertex and skip
        this.vertexIds.pop();
        return;
      }

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

    let point = this.applyAxisLock(rawPoint);

    // Parallel snap: when drawing and no axis lock, check if direction is
    // roughly parallel to any existing edge and constrain if so.
    this.parallelSnapped = false;
    if (this.phase === 'drawing' && this.points.length > 0 && !this.axisLock) {
      const anchor = this.points[this.points.length - 1];
      const result = this.tryParallelSnap(anchor, point);
      if (result) {
        point = result.snappedPoint;
        this.parallelSnapped = true;
        this.showParallelGuide(result.edgeStart, result.edgeEnd);
      } else {
        this.hideParallelGuide();
      }
    } else {
      this.hideParallelGuide();
    }

    this.currentPoint = point;

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

      let dir: Vec3;

      if (this.axisLock) {
        // Use the locked axis direction (respects custom axes)
        const { customAxes } = require('../tool.axes/CustomAxes');
        dir = customAxes.getAxisDirection(this.axisLock);
        // Use the sign from currentPoint to determine positive/negative direction
        if (this.currentPoint) {
          const delta = vec3.sub(this.currentPoint, lastPoint);
          const component = vec3.dot(delta, dir);
          if (component < 0) dir = vec3.negate(dir);
        }
      } else if (this.currentPoint) {
        // Use the preview line direction (cursor direction)
        dir = vec3.normalize(vec3.sub(this.currentPoint, lastPoint));
        if (vec3.lengthSq(dir) < 1e-10) return;
      } else {
        return; // No direction available
      }

      targetPoint = vec3.add(lastPoint, vec3.mul(dir, dist));
    }

    const vertex = this.findOrCreateVertex(targetPoint);
    this.vertexIds.push(vertex.id);
    const prevId = this.vertexIds[this.vertexIds.length - 2];
    this.document.geometry.createEdgeWithIntersection(prevId, vertex.id);
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
   * from the last placed point. Respects custom axes orientation.
   */
  private applyAxisLock(point: Vec3): Vec3 {
    if (!this.axisLock || this.points.length === 0) return point;
    const last = this.points[this.points.length - 1];
    const { customAxes } = require('../tool.axes/CustomAxes');
    const axisDir: Vec3 = customAxes.getAxisDirection(this.axisLock);

    // Project the offset onto the locked axis direction
    const offset = vec3.sub(point, last);
    const projLen = vec3.dot(offset, axisDir);
    return vec3.add(last, vec3.mul(axisDir, projLen));
  }

  /**
   * Project a camera ray onto an axis line from an anchor point.
   * Returns the closest point on the axis to the ray.
   */
  private projectRayOntoAxis(ray: { origin: Vec3; direction: Vec3 }, anchor: Vec3, axis: 'x' | 'y' | 'z'): Vec3 {
    const { customAxes } = require('../tool.axes/CustomAxes');
    const axisDir: Vec3 = customAxes.getAxisDirection(axis);

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

  private reset(): void {
    this.points = [];
    this.vertexIds = [];
    this.currentPoint = null;
    this.axisLock = null;
    this.parallelSnapped = false;
    this.hideParallelGuide();
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

  // ── Parallel snap ─────────────────────────────────────────

  /** Angle threshold in radians (~5°) for triggering parallel snap. */
  private static readonly PARALLEL_THRESHOLD = 0.087;

  /**
   * Check if the line from anchor→point is roughly parallel to any existing
   * edge. If so, return the constrained point and the reference edge endpoints.
   */
  private tryParallelSnap(
    anchor: Vec3, point: Vec3,
  ): { snappedPoint: Vec3; edgeStart: Vec3; edgeEnd: Vec3 } | null {
    const offset = vec3.sub(point, anchor);
    const len = vec3.length(offset);
    if (len < 0.01) return null; // Too short to determine direction

    const dir = vec3.normalize(offset);
    const mesh = this.document.geometry.getMesh();

    // Skip parallel snap for large meshes to avoid per-frame lag
    if (mesh.edges.size > 2000) return null;

    const threshold = LineTool.PARALLEL_THRESHOLD;

    let bestAngle = threshold;
    let bestEdgeDir: Vec3 | null = null;
    let bestEdgeStart: Vec3 | null = null;
    let bestEdgeEnd: Vec3 | null = null;

    mesh.edges.forEach((edge) => {
      const v1 = mesh.vertices.get(edge.startVertexId);
      const v2 = mesh.vertices.get(edge.endVertexId);
      if (!v1 || !v2) return;

      const edgeVec = vec3.sub(v2.position, v1.position);
      const edgeLen = vec3.length(edgeVec);
      if (edgeLen < 0.01) return;

      const edgeDir = vec3.normalize(edgeVec);

      // Check parallelism (handle both directions)
      const dot = Math.abs(vec3.dot(dir, edgeDir));
      // dot ≈ 1 means parallel; angle = acos(dot)
      if (dot > 0.9996) return; // Already nearly exact — skip (acos would be ~0)
      const angle = Math.acos(Math.min(dot, 1.0));

      if (angle < bestAngle) {
        bestAngle = angle;
        // Choose direction that aligns with user's cursor direction
        bestEdgeDir = vec3.dot(dir, edgeDir) >= 0 ? edgeDir : vec3.negate(edgeDir);
        bestEdgeStart = { ...v1.position };
        bestEdgeEnd = { ...v2.position };
      }
    });

    if (!bestEdgeDir || !bestEdgeStart || !bestEdgeEnd) return null;

    // Constrain: project offset onto the parallel edge direction
    const projLen = vec3.dot(offset, bestEdgeDir);
    const snappedPoint = vec3.add(anchor, vec3.mul(bestEdgeDir, projLen));

    return { snappedPoint, edgeStart: bestEdgeStart, edgeEnd: bestEdgeEnd };
  }

  /** Show a magenta dashed guide line on the reference edge. */
  private showParallelGuide(start: Vec3, end: Vec3): void {
    this.viewport.renderer.addGuideLine(
      LineTool.PARALLEL_GUIDE_ID, start, end,
      { r: 0.8, g: 0, b: 0.8 }, // magenta
      true, // dashed
    );
  }

  /** Remove the parallel snap guide line. */
  private hideParallelGuide(): void {
    this.viewport.renderer.removeGuideLine(LineTool.PARALLEL_GUIDE_ID);
  }
}
