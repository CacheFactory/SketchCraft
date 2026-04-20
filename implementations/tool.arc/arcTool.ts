// @archigraph tool.arc
// Arc tool: click start, click end, move to set bulge.
// Arrow keys lock to axis during point placement, change plane during bulge.

import type { Vec3, Plane } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool, DRAWING_PLANES } from '../tool.select/BaseTool';
import { v4 as uuid } from 'uuid';

export class ArcTool extends BaseTool {
  readonly id = 'tool.arc';
  readonly name = 'Arc';
  readonly icon = 'arc';
  readonly shortcut = 'A';
  readonly category = 'draw' as const;
  readonly cursor = 'crosshair';

  private startPoint: Vec3 | null = null;
  private endPoint: Vec3 | null = null;
  private drawPlane: Plane = { normal: { x: 0, y: 1, z: 0 }, distance: 0 };
  private segments = 12;
  private currentBulge = 0;
  private step: 0 | 1 | 2 = 0;
  private lastScreenX = 0;
  private lastScreenY = 0;
  private arcPoints: Vec3[] = []; // For preview

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place start point. Arrow keys lock to axis.');
  }

  deactivate(): void {
    if (this.step > 0) this.abortTransaction();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    this.lastScreenX = event.screenX;
    this.lastScreenY = event.screenY;

    if (this.step === 0) {
      const point = event.worldPoint ?? this.screenToDrawingPlane(event);
      if (!point) return;
      this.startPoint = point;
      this.beginTransaction('Draw Arc');
      this.drawPlane = this.getDrawingPlane(this.startPoint);
      this.step = 1;
      this.axisLock = null;
      this.setPhase('drawing');
      this.setStatus('Click to place end point. Arrow keys lock to axis.');
    } else if (this.step === 1) {
      let point = event.worldPoint ?? this.screenToDrawingPlane(event, this.startPoint ?? undefined);
      if (!point) return;
      // Apply axis lock relative to start point
      if (this.axisLock && this.startPoint) {
        point = this.applyAxisLock(point, this.startPoint);
      }
      this.endPoint = point;
      // Compute draw plane that works for the actual chord direction
      this.drawPlane = this.computeArcPlane(this.startPoint!, point);
      this.step = 2;
      this.axisLock = null;
      this.setStatus('Move to set arc bulge, then click. Arrow keys change plane.');
    } else if (this.step === 2) {
      this.createArc();
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    this.lastScreenX = event.screenX;
    this.lastScreenY = event.screenY;

    if (this.step === 2 && this.startPoint && this.endPoint) {
      const point = this.screenToDrawingPlane(event, this.startPoint ?? undefined) ?? this.resolvePoint(event);
      if (!point) return;

      const mid = vec3.lerp(this.startPoint, this.endPoint, 0.5);
      const chord = vec3.sub(this.endPoint, this.startPoint);
      const chordLen = vec3.length(chord);
      if (chordLen < 1e-10) return;

      const perpDir = vec3.normalize(vec3.cross(chord, this.drawPlane.normal));
      const toPoint = vec3.sub(point, mid);
      this.currentBulge = vec3.dot(toPoint, perpDir);
      this.setVCBValue(this.formatDist(Math.abs(this.currentBulge)));
      this.computePreviewPoints();
    } else if (this.step === 1 && this.startPoint) {
      let point = this.screenToDrawingPlane(event, this.startPoint ?? undefined) ?? this.resolvePoint(event);
      if (!point) return;
      // Apply axis lock for end point placement
      if (this.axisLock) {
        const ray = this.viewport.camera.screenToRay(
          event.screenX, event.screenY,
          this.viewport.getWidth(), this.viewport.getHeight(),
        );
        point = this.projectRayOntoAxis(ray, this.startPoint, this.axisLock);
      }
      this.endPoint = point; // Tentative end for preview
      this.setVCBValue(this.formatDist(vec3.distance(this.startPoint, point)));
    }
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.step > 0) this.abortTransaction();
      this.reset();
      this.setStatus('Click to place start point. Arrow keys lock to axis.');
      return;
    }

    if (this.step === 0 || this.step === 1) {
      // During point placement: arrow keys lock to axis
      if (this.handleArrowKeyAxisLock(event)) {
        this.setStatus(this.getAxisLockStatus());
        // Recompute preview from stored screen position
        if (this.step === 1 && this.startPoint && this.lastScreenX > 0) {
          const ray = this.viewport.camera.screenToRay(
            this.lastScreenX, this.lastScreenY,
            this.viewport.getWidth(), this.viewport.getHeight(),
          );
          if (this.axisLock) {
            this.endPoint = this.projectRayOntoAxis(ray, this.startPoint, this.axisLock);
          } else {
            // Unlock — project onto drawing plane
            const planePoint = this.screenToDrawingPlane(
              { screenX: this.lastScreenX, screenY: this.lastScreenY } as ToolMouseEvent,
              this.startPoint,
            );
            if (planePoint) this.endPoint = planePoint;
          }
        }
      }
    } else if (this.step === 2) {
      // During bulge: arrow keys change drawing plane
      if (this.handleArrowKeyPlane(event)) {
        if (this.startPoint) this.drawPlane = this.getDrawingPlane(this.startPoint);
        const info = DRAWING_PLANES[this.drawingPlaneAxis];
        this.setStatus(`Plane: ${info.label}. Set bulge.`);
      }
    }
  }

  onVCBInput(value: string): void {
    const trimmed = value.trim();
    if (trimmed.endsWith('s')) {
      const segs = parseInt(trimmed.slice(0, -1), 10);
      if (!isNaN(segs) && segs >= 2) { this.segments = segs; this.setStatus(`Segments: ${this.segments}`); return; }
    }
    if (this.step === 2) {
      const bulge = this.parseDistance(value);
      if (isNaN(bulge)) return;
      this.currentBulge = bulge;
      this.createArc();
    }
  }

  getVCBLabel(): string {
    if (this.step === 1) return 'Length';
    if (this.step === 2) return 'Bulge';
    return 'Sides';
  }

  getPreview(): ToolPreview | null {
    if (this.step === 1 && this.startPoint && this.endPoint) {
      const lines: { from: Vec3; to: Vec3 }[] = [{ from: this.startPoint, to: this.endPoint }];
      // When axis-locked, also show a small arc hint so user sees the plane
      if (this.axisLock) {
        const plane = this.computeArcPlane(this.startPoint, this.endPoint);
        const chord = vec3.sub(this.endPoint, this.startPoint);
        const chordLen = vec3.length(chord);
        if (chordLen > 1e-10) {
          const perpDir = vec3.normalize(vec3.cross(chord, plane.normal));
          const mid = vec3.lerp(this.startPoint, this.endPoint, 0.5);
          // Show a small perpendicular indicator at the midpoint
          const hintLen = chordLen * 0.15;
          lines.push({ from: mid, to: vec3.add(mid, vec3.mul(perpDir, hintLen)) });
        }
      }
      return { lines };
    }
    if (this.step === 2 && this.arcPoints.length > 1) {
      return { polygon: this.arcPoints }; // Not closed, but renders as a polyline
    }
    return null;
  }

  private reset(): void {
    this.startPoint = null;
    this.endPoint = null;
    this.currentBulge = 0;
    this.step = 0;
    this.arcPoints = [];
    this.axisLock = null;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  /**
   * Compute an arc plane whose normal is NOT parallel to the chord.
   * If the current drawing plane works, use it. Otherwise pick a plane
   * that contains the chord and provides a valid perpendicular direction.
   */
  private computeArcPlane(start: Vec3, end: Vec3): Plane {
    const chord = vec3.sub(end, start);
    const chordLen = vec3.length(chord);
    if (chordLen < 1e-10) return this.getDrawingPlane(start);

    const chordDir = vec3.normalize(chord);

    // Try the current drawing plane first
    const currentNormal = this.getDrawingPlane(start).normal;
    const dot = Math.abs(vec3.dot(chordDir, currentNormal));
    if (dot < 0.95) {
      // Current plane normal is not parallel to chord — it works
      return this.getDrawingPlane(start);
    }

    // Chord is roughly parallel to the plane normal — pick a better plane.
    // Try standard axes and pick the one most perpendicular to the chord.
    const candidates: Vec3[] = [
      { x: 0, y: 1, z: 0 }, // ground/green
      { x: 1, y: 0, z: 0 }, // red
      { x: 0, y: 0, z: 1 }, // blue
    ];

    let bestNormal = candidates[0];
    let bestDot = 1;
    for (const n of candidates) {
      const d = Math.abs(vec3.dot(chordDir, n));
      if (d < bestDot) {
        bestDot = d;
        bestNormal = n;
      }
    }

    const distance = vec3.dot(start, bestNormal);
    return { normal: { ...bestNormal }, distance };
  }

  private computePreviewPoints(): void {
    if (!this.startPoint || !this.endPoint) return;
    const mid = vec3.lerp(this.startPoint, this.endPoint, 0.5);
    const chord = vec3.sub(this.endPoint, this.startPoint);
    const chordLen = vec3.length(chord);
    if (chordLen < 1e-10) return;
    const perpDir = vec3.normalize(vec3.cross(chord, this.drawPlane.normal));
    const arcMid = vec3.add(mid, vec3.mul(perpDir, this.currentBulge));

    this.arcPoints = [this.startPoint];
    for (let i = 1; i < this.segments; i++) {
      const t = i / this.segments;
      const a = vec3.lerp(this.startPoint, arcMid, t);
      const b = vec3.lerp(arcMid, this.endPoint, t);
      this.arcPoints.push(vec3.lerp(a, b, t));
    }
    this.arcPoints.push(this.endPoint);
  }

  // findOrCreateVertex is now in BaseTool

  private createArc(): void {
    if (!this.startPoint || !this.endPoint) return;
    this.computePreviewPoints();

    const vertexIds: string[] = [];
    for (const p of this.arcPoints) {
      const v = this.findOrCreateVertex(p);
      vertexIds.push(v.id);
    }

    // Create all arc edges with intersection detection, grouped under a single curveId.
    // createEdgeWithIntersection handles face splitting via autoCreateFaces.
    const curveId = uuid();
    for (let i = 0; i < vertexIds.length - 1; i++) {
      const edges = this.document.geometry.createEdgeWithIntersection(vertexIds[i], vertexIds[i + 1]);
      for (const edge of edges) edge.curveId = curveId;
    }

    this.commitTransaction();
    this.reset();
    this.setStatus('Arc created. Click to place start point.');
  }
}
