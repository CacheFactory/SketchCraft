// @archigraph tool.tape_measure
// Tape measure: click two points to measure, optionally create construction guides

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';
import type { HistoryManager } from '../data.history/HistoryManager';

export class TapeMeasureTool extends BaseTool {
  readonly id = 'tool.tape_measure';
  readonly name = 'Tape Measure';
  readonly icon = 'ruler';
  readonly shortcut = 'T';
  readonly category = 'measure' as const;
  readonly cursor = 'crosshair';

  private startPoint: Vec3 | null = null;
  private currentPoint: Vec3 | null = null;
  private createGuides = true;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place first measurement point. Ctrl to toggle guide creation.');
  }

  deactivate(): void {
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    // @archigraph tool.tape_measure
    const point = this.getStandardDrawPoint(event, this.startPoint ?? undefined);
    if (!point) return;

    if (this.phase === 'idle') {
      // First click: set start point and create vertex
      this.startPoint = point;
      this.findOrCreateVertex(point);
      this.setPhase('drawing');
      this.setStatus('Click second point to measure distance, or type a distance and press Enter.');
    } else if (this.phase === 'drawing') {
      // Second click: measure and create guide
      this.completeMeasurement(point);
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    const point = this.getStandardDrawPoint(event, this.startPoint ?? undefined);
    if (!point) return;

    this.currentPoint = point;

    if (this.phase === 'drawing' && this.startPoint) {
      const dist = vec3.distance(this.startPoint, point);
      this.setVCBValue(this.formatDist(dist));
    }
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      this.reset();
      this.setStatus('Click to place first measurement point. Ctrl to toggle guide creation.');
      return;
    }

    if (event.key === 'Control') {
      this.createGuides = !this.createGuides;
      this.setStatus(this.createGuides ? 'Guide creation ON' : 'Guide creation OFF');
      return;
    }

    // Arrow keys for drawing plane
    this.handleArrowKeyPlane(event);
  }

  // @archigraph tool.tape_measure
  onVCBInput(value: string): void {
    // VCB input: type a distance after first click to create guide at exact distance
    if (this.phase !== 'drawing' || !this.startPoint || !this.currentPoint) return;

    const dist = this.parseDistance(value);
    if (isNaN(dist) || dist <= 0) return;

    // Compute direction from start to current cursor position
    const delta = vec3.sub(this.currentPoint, this.startPoint);
    const len = vec3.length(delta);
    if (len < 1e-10) return;

    const direction = vec3.normalize(delta);
    const endPoint: Vec3 = vec3.add(this.startPoint, vec3.mul(direction, dist));

    this.completeMeasurement(endPoint);
  }

  getVCBLabel(): string {
    return this.phase === 'drawing' ? 'Distance' : '';
  }

  getPreview(): ToolPreview | null {
    // Show live preview line from first click to cursor
    if (this.phase !== 'drawing' || !this.startPoint || !this.currentPoint) {
      return null;
    }

    return {
      lines: [{ from: this.startPoint, to: this.currentPoint }],
    };
  }

  // ── Private ────────────────────────────────────────────

  private completeMeasurement(endPoint: Vec3): void {
    if (!this.startPoint) return;

    this.beginTransaction('Tape Measure');

    const dist = vec3.distance(this.startPoint, endPoint);
    this.findOrCreateVertex(endPoint);

    // Display distance in VCB and status bar
    this.setVCBValue(this.formatDist(dist));
    this.setStatus(`Distance: ${this.formatDist(dist)}`);

    // Create a construction guide line between the two points
    if (this.createGuides) {
      // @archigraph calls|tool.tape_measure|data.scene|interaction
      const guideId = `guide-${Date.now()}`;
      const guideColor = { r: 0, g: 0, b: 0, a: 0.5 };
      this.viewport.renderer.addGuideLine(guideId, this.startPoint, endPoint, guideColor, true);

      // Record for undo/redo
      const hm = this.document.history as HistoryManager;
      hm.recordGuideLine({
        id: guideId,
        start: { ...this.startPoint },
        end: { ...endPoint },
        color: guideColor,
        dashed: true,
      });
    }

    this.commitTransaction();
    this.reset();
  }

  private reset(): void {
    this.startPoint = null;
    this.currentPoint = null;
    this.setPhase('idle');
  }
}
