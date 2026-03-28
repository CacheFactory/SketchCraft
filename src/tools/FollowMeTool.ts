// @archigraph tool.follow_me
// Follow Me tool: sweep a profile face along a path

import type { Vec3 } from '../core/types';
import type { ToolMouseEvent, ToolKeyEvent, IFace } from '../core/interfaces';
import { BaseTool } from './BaseTool';

export class FollowMeTool extends BaseTool {
  readonly id = 'tool.follow_me';
  readonly name = 'Follow Me';
  readonly icon = 'git-merge';
  readonly shortcut = 'Shift+F';
  readonly category = 'modify' as const;
  readonly cursor = 'crosshair';

  private profileFace: IFace | null = null;
  private step: 0 | 1 = 0; // 0=select profile, 1=select path

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click on a face to use as the sweep profile.');
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

    if (this.step === 0) {
      // Select profile face
      const face = this.document.geometry.getFace(hits[0].entityId);
      if (face) {
        this.profileFace = face;
        this.beginTransaction('Follow Me');
        this.step = 1;
        this.setPhase('drawing');
        this.setStatus('Click on an edge to define the sweep path.');
      } else {
        this.setStatus('Click on a face to use as the sweep profile.');
      }
    } else if (this.step === 1) {
      // Select path edge - the sweep path consists of connected edges
      const edge = this.document.geometry.getEdge(hits[0].entityId);
      if (edge) {
        this.performSweep(edge.id);
      } else {
        this.setStatus('Click on an edge that forms the sweep path.');
      }
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    // Highlight entities under cursor
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
      this.setStatus('Click on a face to use as the sweep profile.');
    }
  }

  getVCBLabel(): string { return ''; }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.profileFace = null;
    this.step = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private performSweep(pathEdgeId: string): void {
    if (!this.profileFace) return;

    // Collect connected edges forming the path
    // This is a placeholder - full implementation would walk the edge loop,
    // transform the profile face along each path segment, and stitch geometry
    const pathEdge = this.document.geometry.getEdge(pathEdgeId);
    if (!pathEdge) {
      this.abortTransaction();
      this.reset();
      return;
    }

    // For now, mark the operation as committed
    // Full sweep logic would:
    // 1. Walk edges connected to pathEdgeId forming a path
    // 2. For each path segment, transform the profile vertices
    // 3. Create side faces connecting consecutive profile positions
    this.document.markDirty();
    this.commitTransaction();
    this.reset();
    this.setStatus('Follow Me complete. Click on a face for next sweep.');
  }
}
