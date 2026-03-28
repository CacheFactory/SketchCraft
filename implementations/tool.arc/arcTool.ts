// @archigraph tool.arc
// Arc tool: click start, click end, move to set bulge. Arrow keys change plane.

import type { Vec3, Plane } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool, DRAWING_PLANES } from '../tool.select/BaseTool';

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
    this.setStatus('Click to place start point. Arrow keys change plane.');
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
      // Prefer snapped point for start (connects to existing geometry)
      const point = event.worldPoint ?? this.screenToDrawingPlane(event);
      if (!point) return;
      this.startPoint = point;
      this.beginTransaction('Draw Arc');
      this.drawPlane = this.getDrawingPlane(this.startPoint);
      this.step = 1;
      this.setPhase('drawing');
      this.setStatus('Click to place end point. Arrow keys change plane.');
    } else if (this.step === 1) {
      // Prefer snapped point for end (connects to existing geometry)
      const point = event.worldPoint ?? this.screenToDrawingPlane(event, this.startPoint ?? undefined);
      if (!point) return;
      this.endPoint = point;
      this.step = 2;
      this.setStatus('Move to set arc bulge, then click.');
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
      this.setVCBValue(Math.abs(this.currentBulge).toFixed(3));
      this.computePreviewPoints();
    } else if (this.step === 1 && this.startPoint) {
      const point = this.screenToDrawingPlane(event, this.startPoint ?? undefined) ?? this.resolvePoint(event);
      if (point) {
        this.endPoint = point; // Tentative end for preview
        this.setVCBValue(vec3.distance(this.startPoint, point).toFixed(3));
      }
    }
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.step > 0) this.abortTransaction();
      this.reset();
      this.setStatus('Click to place start point. Arrow keys change plane.');
      return;
    }
    if (this.handleArrowKeyPlane(event)) {
      if (this.startPoint) this.drawPlane = this.getDrawingPlane(this.startPoint);
      const info = DRAWING_PLANES[this.drawingPlaneAxis];
      this.setStatus(`Plane: ${info.label}. ${this.step === 0 ? 'Click start.' : this.step === 1 ? 'Click end.' : 'Set bulge.'}`);
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
      return { lines: [{ from: this.startPoint, to: this.endPoint }] };
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
    this.setPhase('idle');
    this.setVCBValue('');
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

    // Create all arc edges (plain, no auto-face yet)
    for (let i = 0; i < vertexIds.length - 1; i++) {
      this.document.geometry.createEdge(vertexIds[i], vertexIds[i + 1]);
    }

    // Split any face the arc bisects.
    // This handles endpoints on face corners AND on face edges.
    this.document.geometry.splitFaceWithPath(vertexIds);

    this.commitTransaction();
    this.reset();
    this.setStatus('Arc created. Click to place start point.');
  }
}
