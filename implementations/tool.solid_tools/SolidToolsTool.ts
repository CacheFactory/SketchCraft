// @archigraph tool.solid_tools
// Solid tools: boolean operations (union, subtract, intersect) on solid groups

import type { ToolMouseEvent, ToolKeyEvent } from '../../src/core/interfaces';
import { BaseTool } from '../tool.select/BaseTool';

export type SolidOperation = 'union' | 'subtract' | 'intersect';

export class SolidToolsTool extends BaseTool {
  readonly id = 'tool.solid_tools';
  readonly name = 'Solid Tools';
  readonly icon = 'layers';
  readonly shortcut = 'Shift+O';
  readonly category = 'modify' as const;
  readonly cursor = 'crosshair';

  private operation: SolidOperation = 'union';
  private firstSolidId: string | null = null;
  private step: 0 | 1 = 0;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus(`Solid ${this.operation}. Click first solid group.`);
  }

  deactivate(): void {
    if (this.step > 0) this.abortTransaction();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    const hits = this.viewport.raycastScene(event.screenX, event.screenY);
    if (hits.length === 0) return;

    const entityId = hits[0].entityId;
    const entity = this.document.scene.getEntity(entityId);
    if (!entity || entity.type !== 'group') {
      this.setStatus('Click on a solid group.');
      return;
    }

    if (this.step === 0) {
      this.firstSolidId = entityId;
      this.beginTransaction(`Solid ${this.operation}`);
      this.step = 1;
      this.setPhase('drawing');
      this.setStatus(`Click second solid group to ${this.operation}.`);
    } else if (this.step === 1) {
      this.performOperation(entityId);
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    const hits = this.viewport.raycastScene(event.screenX, event.screenY);
    if (hits.length > 0) {
      this.document.selection.setPreSelection(hits[0].entityId);
    } else {
      this.document.selection.setPreSelection(null);
    }
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.step > 0) this.abortTransaction();
      this.reset();
      this.setStatus(`Solid ${this.operation}. Click first solid group.`);
    }

    // Tab to cycle operations
    if (event.key === 'Tab') {
      const ops: SolidOperation[] = ['union', 'subtract', 'intersect'];
      const idx = ops.indexOf(this.operation);
      this.operation = ops[(idx + 1) % ops.length];
      this.setStatus(`Solid ${this.operation}. Click first solid group.`);
    }
  }

  getVCBLabel(): string { return ''; }

  setOperation(op: SolidOperation): void {
    this.operation = op;
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.firstSolidId = null;
    this.step = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private performOperation(secondSolidId: string): void {
    if (!this.firstSolidId) {
      this.abortTransaction();
      this.reset();
      return;
    }

    // Delegate to geometry operations module
    // The actual CSG boolean operation would be performed by the geometry engine.
    // This is a placeholder that marks the transaction.
    this.document.markDirty();
    this.commitTransaction();
    this.reset();
    this.setStatus(`Solid ${this.operation} complete. Click first solid group.`);
  }
}
