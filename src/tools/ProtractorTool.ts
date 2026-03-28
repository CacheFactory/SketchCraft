// @archigraph tool.protractor
// Protractor tool: click center, click baseline, move to measure angle

import type { Vec3 } from '../core/types';
import type { ToolMouseEvent, ToolKeyEvent } from '../core/interfaces';
import { vec3, radToDeg } from '../core/math';
import { BaseTool } from './BaseTool';

export class ProtractorTool extends BaseTool {
  readonly id = 'tool.protractor';
  readonly name = 'Protractor';
  readonly icon = 'compass';
  readonly shortcut = 'Shift+P';
  readonly category = 'measure' as const;
  readonly cursor = 'crosshair';

  private center: Vec3 | null = null;
  private baselinePoint: Vec3 | null = null;
  private currentAngle = 0;
  private step: 0 | 1 | 2 = 0;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place protractor center.');
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
      this.center = point;
      this.step = 1;
      this.setPhase('drawing');
      this.setStatus('Click to set baseline direction.');
    } else if (this.step === 1) {
      this.baselinePoint = point;
      this.step = 2;
      this.setStatus('Move to measure angle, then click to place guide.');
    } else if (this.step === 2) {
      // Place construction guide line at measured angle
      if (this.center) {
        const dir = vec3.normalize(vec3.sub(point, this.center));
        const guideEnd = vec3.add(this.center, vec3.mul(dir, 1000));
        this.viewport.renderer.addGuideLine(
          `protractor-guide-${Date.now()}`,
          this.center,
          guideEnd,
          { r: 0, g: 0, b: 0, a: 0.5 },
          true,
        );
      }

      this.setStatus(`Angle: ${this.currentAngle.toFixed(1)} degrees`);
      this.reset();
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.step !== 2 || !this.center || !this.baselinePoint) return;
    const point = this.resolvePoint(event);
    if (!point) return;

    const baseDir = vec3.normalize(vec3.sub(this.baselinePoint, this.center));
    const curDir = vec3.normalize(vec3.sub(point, this.center));
    this.currentAngle = radToDeg(vec3.angle(baseDir, curDir));
    this.setVCBValue(this.currentAngle.toFixed(1));
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      this.reset();
      this.setStatus('Click to place protractor center.');
    }
  }

  onVCBInput(value: string): void {
    // VCB shows measured angle; no input action
  }

  getVCBLabel(): string {
    return this.step === 2 ? 'Angle' : '';
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.center = null;
    this.baselinePoint = null;
    this.currentAngle = 0;
    this.step = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }
}
