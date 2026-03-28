// @archigraph tool.dimension
// Dimension tool: click two points to create a dimension annotation

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';

export class DimensionTool extends BaseTool {
  readonly id = 'tool.dimension';
  readonly name = 'Dimension';
  readonly icon = 'type';
  readonly shortcut = 'D';
  readonly category = 'measure' as const;
  readonly cursor = 'crosshair';

  private startPoint: Vec3 | null = null;
  private endPoint: Vec3 | null = null;
  private step: 0 | 1 | 2 = 0; // 0=start, 1=end, 2=offset

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click first dimension point.');
  }

  deactivate(): void {
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.resolvePoint(event);
    if (!point) return;

    if (this.step === 0) {
      this.startPoint = point;
      this.step = 1;
      this.setPhase('drawing');
      this.setStatus('Click second dimension point.');
    } else if (this.step === 1) {
      this.endPoint = point;
      this.step = 2;
      const dist = vec3.distance(this.startPoint!, point);
      this.setVCBValue(dist.toFixed(4));
      this.setStatus('Move to offset dimension line, then click to place.');
    } else if (this.step === 2) {
      this.createDimension(point);
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.step === 1 && this.startPoint) {
      const point = this.resolvePoint(event);
      if (point) {
        this.setVCBValue(vec3.distance(this.startPoint, point).toFixed(4));
      }
    }
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      this.reset();
      this.setStatus('Click first dimension point.');
    }
  }

  getVCBLabel(): string {
    return this.step >= 1 ? 'Length' : '';
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.startPoint = null;
    this.endPoint = null;
    this.step = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private createDimension(_offsetPoint: Vec3): void {
    if (!this.startPoint || !this.endPoint) return;

    // Create dimension guide lines for visual representation
    const dist = vec3.distance(this.startPoint, this.endPoint);

    // Main dimension line
    this.viewport.renderer.addGuideLine(
      `dim-${Date.now()}`,
      this.startPoint,
      this.endPoint,
      { r: 0.2, g: 0.2, b: 0.2, a: 1 },
      false,
    );

    this.setStatus(`Dimension placed: ${dist.toFixed(4)}`);
    this.reset();
  }
}
