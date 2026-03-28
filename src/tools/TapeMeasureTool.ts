// @archigraph tool.tape_measure
// Tape measure: click two points to measure, optionally create construction guides

import type { Vec3 } from '../core/types';
import type { ToolMouseEvent, ToolKeyEvent } from '../core/interfaces';
import { vec3 } from '../core/math';
import { BaseTool } from './BaseTool';

export class TapeMeasureTool extends BaseTool {
  readonly id = 'tool.tape_measure';
  readonly name = 'Tape Measure';
  readonly icon = 'ruler';
  readonly shortcut = 'T';
  readonly category = 'measure' as const;
  readonly cursor = 'crosshair';

  private startPoint: Vec3 | null = null;
  private createGuides = true;
  private guideId: string | null = null;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place first measurement point. Ctrl to toggle guide creation.');
  }

  deactivate(): void {
    this.cleanupGuide();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.resolvePoint(event);
    if (!point) return;

    if (this.phase === 'idle') {
      this.startPoint = point;
      this.setPhase('drawing');
      this.setStatus('Click second point to measure distance.');
    } else if (this.phase === 'drawing') {
      const dist = vec3.distance(this.startPoint!, point);
      this.setVCBValue(dist.toFixed(4));
      this.setStatus(`Distance: ${dist.toFixed(4)}`);

      if (this.createGuides) {
        // Create a construction guide line
        this.viewport.renderer.addGuideLine(
          `guide-${Date.now()}`,
          this.startPoint!,
          point,
          { r: 0, g: 0, b: 0, a: 0.5 },
          true,
        );
      }

      this.reset();
      this.setPhase('idle');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase !== 'drawing' || !this.startPoint) return;
    const point = this.resolvePoint(event);
    if (!point) return;

    const dist = vec3.distance(this.startPoint, point);
    this.setVCBValue(dist.toFixed(4));

    // Show temporary guide line
    this.cleanupGuide();
    this.guideId = `tape-preview-${Date.now()}`;
    this.viewport.renderer.addGuideLine(
      this.guideId,
      this.startPoint,
      point,
      { r: 0.5, g: 0.5, b: 0.5, a: 0.5 },
      true,
    );
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      this.cleanupGuide();
      this.reset();
      this.setStatus('Click to place first measurement point.');
    }

    if (event.key === 'Control') {
      this.createGuides = !this.createGuides;
      this.setStatus(this.createGuides ? 'Guide creation ON' : 'Guide creation OFF');
    }
  }

  onVCBInput(value: string): void {
    // VCB shows measured distance; no input action needed for measurement mode
  }

  getVCBLabel(): string {
    return this.phase === 'drawing' ? 'Distance' : '';
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.startPoint = null;
    this.setPhase('idle');
  }

  private cleanupGuide(): void {
    if (this.guideId) {
      this.viewport.renderer.removeGuideLine(this.guideId);
      this.guideId = null;
    }
  }
}
