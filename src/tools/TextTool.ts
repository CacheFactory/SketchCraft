// @archigraph tool.text
// Text tool: click to place text label in 3D space

import type { Vec3 } from '../core/types';
import type { ToolMouseEvent, ToolKeyEvent } from '../core/interfaces';
import { BaseTool } from './BaseTool';

export class TextTool extends BaseTool {
  readonly id = 'tool.text';
  readonly name = 'Text';
  readonly icon = 'type';
  readonly shortcut = 'Shift+T';
  readonly category = 'construct' as const;
  readonly cursor = 'text';

  private placementPoint: Vec3 | null = null;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place a text label.');
  }

  deactivate(): void {
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.resolvePoint(event);
    if (!point) return;

    this.placementPoint = point;
    this.setPhase('active');
    this.setStatus('Type text in VCB and press Enter to place label.');
  }

  onVCBInput(value: string): void {
    if (!this.placementPoint || !value.trim()) return;

    // Place a text entity at the clicked point
    // This would create a text entity in the scene via the scene manager.
    // For now, we create a guide line as a visual placeholder with the text as tooltip.
    this.viewport.renderer.addGuideLine(
      `text-${Date.now()}`,
      this.placementPoint,
      this.placementPoint,
      { r: 0, g: 0, b: 0, a: 1 },
      false,
    );

    this.setStatus(`Text "${value.trim()}" placed.`);
    this.reset();
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      this.reset();
      this.setStatus('Click to place a text label.');
    }
  }

  getVCBLabel(): string {
    return this.phase === 'active' ? 'Text' : '';
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.placementPoint = null;
    this.setPhase('idle');
    this.setVCBValue('');
  }
}
