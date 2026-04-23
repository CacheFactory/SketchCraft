// @archigraph tool.pushpull
// Push/Pull tool: click a face, drag to extrude it into a 3D solid.
// Creates side faces + top cap. Like SketchUp's signature tool.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview, IFace, ToolEventNeeds } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';

export class PushPullTool extends BaseTool {
  readonly id = 'tool.pushpull';
  readonly name = 'Push/Pull';
  readonly icon = 'box';
  readonly shortcut = 'P';
  readonly category = 'modify' as const;
  readonly cursor = 'ns-resize';

  private selectedFaceId: string | null = null;
  private faceNormal: Vec3 | null = null;
  private startScreenY = 0;
  private currentDistance = 0;

  activate(): void {
    super.activate();
    this.reset();

    // SketchUp behavior: if a face is already selected, start Push/Pull on it
    const selectedIds = this.resolveSelectedEntityIds();
    if (selectedIds.length === 1) {
      const face = this.document.geometry.getFace(selectedIds[0]);
      if (face) {
        this.startOnFace(face, 0);
        this.setStatus('Move mouse up/down to extrude, then click. Or type a distance.');
        return;
      }
    }

    this.setStatus('Click on a face to push/pull.');
  }

  deactivate(): void {
    if (this.phase !== 'idle') this.abortTransaction();
    this.document.selection.setPreSelection(null);
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    if (this.phase === 'idle') {
      // Use hit entity from event (supports GPU pick for batched mode)
      if (event.hitEntityId) {
        const face = this.document.geometry.getFace(event.hitEntityId);
        if (face) {
          this.startOnFace(face, event.screenY);
          this.setStatus('Move mouse up/down to set distance, then click to commit.');
          return;
        }
      }
      this.setStatus('No face found. Click directly on a face.');
    } else if (this.phase === 'drawing') {
      // Commit the extrusion
      this.commitExtrusion();
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    if (this.phase === 'idle') {
      // Pre-selection highlight: show which face will be pushed/pulled
      if (event.hitEntityId) {
        const face = this.document.geometry.getFace(event.hitEntityId);
        if (face) {
          this.document.selection.setPreSelection(face.id);
          this.setViewportCursor(true);
          return;
        }
      }
      this.document.selection.setPreSelection(null);
      this.setViewportCursor(false);
      return;
    }

    if (this.phase !== 'drawing' || !this.faceNormal) return;

    // Use screen-space Y movement to determine extrusion distance.
    // Moving mouse up = positive extrusion (along normal).
    // Scale: 1 pixel ~= 0.05 world units (adjustable feel).
    const deltaPixels = this.startScreenY - event.screenY; // up = positive
    this.currentDistance = deltaPixels * 0.05;
    this.setVCBValue(this.formatDist(this.currentDistance));
    this.setStatus(`Distance: ${this.formatDist(this.currentDistance)}. Click to commit.`);
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.phase !== 'idle') this.abortTransaction();
      this.reset();
      this.setStatus('Click on a face to push/pull.');
    }
  }

  onVCBInput(value: string): void {
    if (this.phase !== 'drawing') return;

    const dist = this.parseDistance(value);
    if (isNaN(dist) || dist === 0) return;

    this.currentDistance = dist;
    this.commitExtrusion();
  }

  getVCBLabel(): string {
    return this.phase === 'drawing' ? 'Distance' : '';
  }

  getEventNeeds(): ToolEventNeeds {
    return { snap: false, raycast: false, edgeRaycast: false, liveSyncOnMove: false, mutatesOnClick: true };
  }

  getPreview(): ToolPreview | null {
    if (this.phase !== 'drawing' || !this.selectedFaceId || !this.faceNormal || Math.abs(this.currentDistance) < 0.001) return null;

    const verts = this.document.geometry.getFaceVertices(this.selectedFaceId);
    if (verts.length < 3) return null;

    const offset = vec3.mul(this.faceNormal, this.currentDistance);

    // Show the top face outline at the extruded position
    const topPoints = verts.map(v => vec3.add(v.position, offset));

    // Also show vertical guide lines from original to extruded
    const lines = verts.map(v => ({
      from: v.position,
      to: vec3.add(v.position, offset),
    }));

    return { polygon: topPoints, lines };
  }

  // ── Private ────────────────────────────────────────────

  /** Newell's method — compute normal from current vertex positions */
  private computeNormalFromPositions(positions: Vec3[]): Vec3 {
    const n: Vec3 = { x: 0, y: 0, z: 0 };
    const len = positions.length;
    for (let i = 0; i < len; i++) {
      const curr = positions[i];
      const next = positions[(i + 1) % len];
      n.x += (curr.y - next.y) * (curr.z + next.z);
      n.y += (curr.z - next.z) * (curr.x + next.x);
      n.z += (curr.x - next.x) * (curr.y + next.y);
    }
    return vec3.normalize(n);
  }

  private setViewportCursor(isPointer: boolean): void {
    const container = document.querySelector('.viewport-container') as HTMLElement;
    if (container) {
      container.style.cursor = isPointer ? 'ns-resize' : 'crosshair';
    }
  }

  private startOnFace(face: IFace, screenY: number): void {
    this.selectedFaceId = face.id;

    // Recompute normal from current vertex positions — the stored face.normal
    // may be stale if vertices were moved by rotate/move/scale tools.
    const verts = this.document.geometry.getFaceVertices(face.id);
    let normal: Vec3;
    if (verts.length >= 3) {
      const positions = verts.map(v => v.position);
      normal = this.computeNormalFromPositions(positions);
    } else {
      normal = vec3.clone(face.normal);
    }
    const len = vec3.length(normal);
    if (len > 0) normal = vec3.div(normal, len);
    this.faceNormal = normal;

    this.startScreenY = screenY;
    this.currentDistance = 0;
    this.beginTransaction('Push/Pull');
    this.setPhase('drawing');
  }

  private reset(): void {
    this.selectedFaceId = null;
    this.faceNormal = null;
    this.startScreenY = 0;
    this.currentDistance = 0;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  /**
   * Check if a face already has side walls on ALL edges — meaning it's
   * part of an existing 3D solid from a previous push/pull. Only then
   * should we move vertices instead of creating new geometry.
   *
   * SketchUp behavior: the first push/pull always creates new side faces.
   * Only subsequent push/pulls on the same face (which now has side walls)
   * will stretch existing walls by moving vertices.
   */
  private hasSideWalls(faceId: string, normal: Vec3): boolean {
    const faceEdges = this.document.geometry.getFaceEdges(faceId);
    if (faceEdges.length === 0) return false;

    // Every edge must have a perpendicular side wall for this to be a "move" operation
    for (const edge of faceEdges) {
      const adjacentFaces = this.document.geometry.getEdgeFaces(edge.id);
      let hasWallOnThisEdge = false;
      for (const adj of adjacentFaces) {
        if (adj.id === faceId) continue;
        // Recompute adjacent face normal from current vertex positions
        const adjVerts = this.document.geometry.getFaceVertices(adj.id);
        let adjNormal = adj.normal;
        if (adjVerts.length >= 3) {
          adjNormal = this.computeNormalFromPositions(adjVerts.map(v => v.position));
        }
        // Side wall = roughly perpendicular to push/pull face (dot ≈ 0)
        const dot = Math.abs(vec3.dot(adjNormal, normal));
        if (dot < 0.3) {
          hasWallOnThisEdge = true;
          break;
        }
      }
      if (!hasWallOnThisEdge) return false; // Missing wall on this edge → need to extrude
    }
    return true;
  }

  private commitExtrusion(): void {
    if (!this.selectedFaceId || !this.faceNormal || Math.abs(this.currentDistance) < 1e-10) {
      this.abortTransaction();
      this.reset();
      this.setStatus('Push/Pull cancelled (zero distance). Click on a face.');
      return;
    }

    const faceVertices = this.document.geometry.getFaceVertices(this.selectedFaceId);
    if (faceVertices.length < 3) {
      this.abortTransaction();
      this.reset();
      this.setStatus('Invalid face. Click on a face to push/pull.');
      return;
    }

    const offset = vec3.mul(this.faceNormal, this.currentDistance);

    if (this.hasSideWalls(this.selectedFaceId, this.faceNormal)) {
      // 3D mode: just move existing vertices, side walls stretch automatically
      for (const v of faceVertices) {
        v.position = vec3.add(v.position, offset);
      }
    } else {
      // 2D mode: extrude — create side walls and top cap
      const newVertexIds: string[] = [];
      for (const v of faceVertices) {
        const newPos = vec3.add(v.position, offset);
        const newVertex = this.document.geometry.createVertex(newPos);
        newVertexIds.push(newVertex.id);
      }

      const n = faceVertices.length;
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const bottomA = faceVertices[i].id;
        const bottomB = faceVertices[next].id;
        const topA = newVertexIds[i];
        const topB = newVertexIds[next];

        this.document.geometry.createEdge(bottomA, topA);
        this.document.geometry.createEdge(topA, topB);
        if (i === n - 1) {
          this.document.geometry.createEdge(bottomB, topB);
        }

        this.document.geometry.createFace([bottomA, bottomB, topB, topA]);
      }

      this.document.geometry.createFace(newVertexIds);
    }

    this.commitTransaction();
    this.document.selection.clear();
    this.reset();
    this.setStatus('Push/Pull complete! Click another face.');
  }
}
