// @archigraph tool.scale
// Scale tool: shows bounding-box grips (corners + edge midpoints + center = 9).
// Click a grip, then drag to scale relative to the opposite grip.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview, ToolEventNeeds } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';
import * as THREE from 'three';

/** Which kind of grip: corner scales 2-axis, edge scales 1-axis, center scales uniform. */
type GripKind = 'corner' | 'edge' | 'center';

interface Grip {
  position: Vec3;    // world position
  kind: GripKind;
  anchor: Vec3;      // opposite grip position (scale origin)
  /** Which axes to scale: null = all, otherwise only these axes are affected. */
  scaleAxes: ('x' | 'y' | 'z')[] | null;
  mesh: THREE.Mesh;
}

export class ScaleTool extends BaseTool {
  readonly id = 'tool.scale';
  readonly name = 'Scale';
  readonly icon = 'scale';
  readonly shortcut = 'S';
  readonly category = 'modify' as const;
  readonly cursor = 'nwse-resize';

  private vertexIds: string[] = [];
  private originalPositions = new Map<string, Vec3>();
  private grips: Grip[] = [];
  private activeGrip: Grip | null = null;
  private hoveredGrip: Grip | null = null;
  private startDist = 0;
  private currentScale = 1;
  private bbCenter: Vec3 = { x: 0, y: 0, z: 0 };

  // Three.js overlay objects
  private gripGroup: THREE.Group | null = null;
  private bbLines: string[] = []; // guide line IDs for cleanup

  activate(): void {
    super.activate();
    this.reset();
    if (!this.document.selection.isEmpty) {
      this.gatherVertices();
      if (this.vertexIds.length > 0) {
        this.showGrips();
        this.setStatus('Click a green grip to start scaling.');
      } else {
        this.setStatus('Select a face or edge first.');
      }
    } else {
      this.setStatus('Select a face or edge, then activate Scale.');
    }
  }

  deactivate(): void {
    if (this.phase !== 'idle') { this.restoreOriginal(); this.abortTransaction(); }
    this.clearGrips();
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;

    if (this.phase === 'idle') {
      // If nothing selected yet, try clicking to select
      if (this.vertexIds.length === 0) {
        if (event.hitEntityId) {
          this.document.selection.select(event.hitEntityId);
          this.gatherVertices();
          if (this.vertexIds.length > 0) {
            this.showGrips();
            this.setStatus('Click a green grip to start scaling.');
          }
        }
        return;
      }

      // Check if click is near a grip
      const grip = this.findNearestGrip(event.screenX, event.screenY);
      if (!grip) {
        this.setStatus('Click one of the green grips.');
        return;
      }

      this.activeGrip = grip;
      this.startDist = 0;
      this.saveOriginal();
      this.beginTransaction('Scale', [...this.originalPositions.keys()]);
      this.setPhase('drawing');
      this.setStatus('Drag to scale. Type factor and Enter for exact.');
    } else if (this.phase === 'drawing') {
      this.commitTransaction();
      this.clearGrips();
      this.gatherVertices();
      this.showGrips();
      this.setPhase('idle');
      this.setStatus('Scale complete. Click a grip to scale again.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    // Keep grips at constant screen size
    if (this.grips.length > 0) this.scaleGripsToCamera();

    if (this.phase === 'idle') {
      // Highlight grip under cursor
      const grip = this.findNearestGrip(event.screenX, event.screenY);
      if (grip !== this.hoveredGrip) {
        if (this.hoveredGrip) this.setGripColor(this.hoveredGrip, 0x00aa00);
        this.hoveredGrip = grip;
        if (grip) this.setGripColor(grip, 0xffff00);
      }
      return;
    }

    if (this.phase !== 'drawing' || !this.activeGrip) return;
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    const anchor = this.activeGrip.anchor;
    const dist = vec3.distance(point, anchor);
    if (this.startDist === 0) {
      this.startDist = Math.max(vec3.distance(this.activeGrip.position, anchor), 0.01);
    }

    this.currentScale = dist / this.startDist;
    this.setVCBValue(this.currentScale.toFixed(3));
    this.applyScale(this.currentScale, anchor, this.activeGrip.scaleAxes);
    this.updateGripPositions();
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.phase !== 'idle') { this.restoreOriginal(); this.abortTransaction(); }
      this.clearGrips();
      this.reset();
      this.setStatus('Scale cancelled.');
    }
  }

  onVCBInput(value: string): void {
    if (this.phase !== 'drawing' || !this.activeGrip) return;
    const factor = this.parseDistance(value);
    if (isNaN(factor) || factor <= 0) return;
    this.applyScale(factor, this.activeGrip.anchor, this.activeGrip.scaleAxes);
    this.commitTransaction();
    this.clearGrips();
    this.gatherVertices();
    this.showGrips();
    this.setPhase('idle');
    this.setStatus('Scale complete.');
    this.setVCBValue('');
  }

  getVCBLabel(): string { return this.phase === 'drawing' ? 'Factor' : ''; }
  getPreview(): ToolPreview | null { return null; }

  getEventNeeds(): ToolEventNeeds {
    const isActive = this.phase === 'active' || this.phase === 'drawing';
    return { snap: isActive, raycast: isActive, edgeRaycast: false, liveSyncOnMove: isActive, mutatesOnClick: true };
  }

  // ── Private ────────────────────────────────────────────

  private reset(): void {
    this.vertexIds = [];
    this.originalPositions.clear();
    this.activeGrip = null;
    this.hoveredGrip = null;
    this.startDist = 0;
    this.currentScale = 1;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private gatherVertices(): void {
    this.vertexIds = [];
    const seen = new Set<string>();
    for (const eid of this.resolveSelectedEntityIds()) {
      const f = this.document.geometry.getFace(eid);
      if (f) {
        for (const vid of f.vertexIds) {
          if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); }
        }
        continue;
      }
      const e = this.document.geometry.getEdge(eid);
      if (e) {
        for (const vid of [e.startVertexId, e.endVertexId]) {
          if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); }
        }
      }
    }
  }

  private saveOriginal(): void {
    for (const vid of this.vertexIds) {
      const v = this.document.geometry.getVertex(vid);
      if (v) this.originalPositions.set(vid, vec3.clone(v.position));
    }
  }

  private restoreOriginal(): void {
    for (const [vid, p] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid);
      if (v) { v.position.x = p.x; v.position.y = p.y; v.position.z = p.z; }
    }
  }

  private applyScale(factor: number, anchor: Vec3, axes: ('x' | 'y' | 'z')[] | null): void {
    for (const [vid, orig] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid);
      if (!v) continue;
      const rel = vec3.sub(orig, anchor);
      if (axes) {
        v.position.x = axes.includes('x') ? anchor.x + rel.x * factor : orig.x;
        v.position.y = axes.includes('y') ? anchor.y + rel.y * factor : orig.y;
        v.position.z = axes.includes('z') ? anchor.z + rel.z * factor : orig.z;
      } else {
        const scaled = vec3.add(anchor, vec3.mul(rel, factor));
        v.position.x = scaled.x; v.position.y = scaled.y; v.position.z = scaled.z;
      }
    }
    this._dirtyVertexIds = this.vertexIds;
  }

  // ── Bounding Box & Grips ──────────────────────────────

  private computeBoundingBox(): { min: Vec3; max: Vec3 } {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const vid of this.vertexIds) {
      const v = this.document.geometry.getVertex(vid);
      if (!v) continue;
      const p = v.position;
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; if (p.z > maxZ) maxZ = p.z;
    }
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };
  }

  private showGrips(): void {
    this.clearGrips();

    const bb = this.computeBoundingBox();
    const mn = bb.min;
    const mx = bb.max;
    this.bbCenter = { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 };

    // Determine if this is essentially 2D (one axis has zero or near-zero extent)
    const dx = mx.x - mn.x;
    const dy = mx.y - mn.y;
    const dz = mx.z - mn.z;
    const threshold = 0.001;

    const flat2D = (dx < threshold ? 'x' : null) || (dy < threshold ? 'y' : null) || (dz < threshold ? 'z' : null);

    // Get overlay scene
    const overlayScene = (this.viewport.renderer as any).getOverlayScene?.() as THREE.Scene | undefined;
    if (!overlayScene) return;

    this.gripGroup = new THREE.Group();
    this.gripGroup.name = 'scale-grips';
    this.gripGroup.renderOrder = 999;

    if (flat2D) {
      // 2D bounding box — 8 grips around perimeter + 1 center
      this.show2DGrips(mn, mx, flat2D);
    } else {
      // 3D bounding box — 8 corner grips + center
      this.show3DGrips(mn, mx);
    }

    overlayScene.add(this.gripGroup);

    // Draw bounding box edges as yellow guide lines
    this.drawBoundingBoxLines(mn, mx);

    // Scale grips to current camera distance
    this.scaleGripsToCamera();
  }

  private show2DGrips(mn: Vec3, mx: Vec3, flatAxis: string): void {
    // For a flat face, compute 4 corners and 4 edge midpoints.
    // Corners: scale both in-plane axes. Edge midpoints: scale only the
    // axis perpendicular to that edge (moves just that side).
    let corners: Vec3[];
    // The two in-plane axes, ordered so edges [0→1] and [2→3] are along axis1,
    // and edges [1→2] and [3→0] are along axis2.
    let axis1: 'x' | 'y' | 'z';
    let axis2: 'x' | 'y' | 'z';
    let bothAxes: ('x' | 'y' | 'z')[];

    if (flatAxis === 'y') {
      // XZ plane — corners go around in XZ
      const y = mn.y;
      corners = [
        { x: mn.x, y, z: mn.z }, { x: mx.x, y, z: mn.z },
        { x: mx.x, y, z: mx.z }, { x: mn.x, y, z: mx.z },
      ];
      axis1 = 'x'; axis2 = 'z'; bothAxes = ['x', 'z'];
    } else if (flatAxis === 'x') {
      // YZ plane
      const x = mn.x;
      corners = [
        { x, y: mn.y, z: mn.z }, { x, y: mx.y, z: mn.z },
        { x, y: mx.y, z: mx.z }, { x, y: mn.y, z: mx.z },
      ];
      axis1 = 'y'; axis2 = 'z'; bothAxes = ['y', 'z'];
    } else {
      // XY plane (flat on Z)
      const z = mn.z;
      corners = [
        { x: mn.x, y: mn.y, z }, { x: mx.x, y: mn.y, z },
        { x: mx.x, y: mx.y, z }, { x: mn.x, y: mx.y, z },
      ];
      axis1 = 'x'; axis2 = 'y'; bothAxes = ['x', 'y'];
    }

    // 4 corner grips — scale both in-plane axes from opposite corner
    for (let i = 0; i < 4; i++) {
      const opposite = corners[(i + 2) % 4];
      this.addGrip(corners[i], 'corner', opposite, bothAxes);
    }

    // 4 edge midpoint grips — scale only the axis PERPENDICULAR to that edge.
    // Edges 0→1 and 2→3 run along axis1, so their midpoints scale axis2 only.
    // Edges 1→2 and 3→0 run along axis2, so their midpoints scale axis1 only.
    const edgeAxis: ('x' | 'y' | 'z')[][] = [[axis2], [axis1], [axis2], [axis1]];
    for (let i = 0; i < 4; i++) {
      const mid = vec3.lerp(corners[i], corners[(i + 1) % 4], 0.5);
      const oppMid = vec3.lerp(corners[(i + 2) % 4], corners[(i + 3) % 4], 0.5);
      this.addGrip(mid, 'edge', oppMid, edgeAxis[i]);
    }

    // Center grip — uniform scale on all axes
    this.addGrip(this.bbCenter, 'center', this.bbCenter, null);
  }

  private show3DGrips(mn: Vec3, mx: Vec3): void {
    // 8 corners of the 3D bounding box — scale all 3 axes
    const corners: Vec3[] = [
      { x: mn.x, y: mn.y, z: mn.z }, { x: mx.x, y: mn.y, z: mn.z },
      { x: mx.x, y: mn.y, z: mx.z }, { x: mn.x, y: mn.y, z: mx.z },
      { x: mn.x, y: mx.y, z: mn.z }, { x: mx.x, y: mx.y, z: mn.z },
      { x: mx.x, y: mx.y, z: mx.z }, { x: mn.x, y: mx.y, z: mx.z },
    ];

    for (let i = 0; i < 8; i++) {
      const opposite = corners[7 - i];
      this.addGrip(corners[i], 'corner', opposite, ['x', 'y', 'z']);
    }

    // Center grip — uniform
    this.addGrip(this.bbCenter, 'center', this.bbCenter, null);
  }

  private addGrip(position: Vec3, kind: GripKind, anchor: Vec3, scaleAxes: ('x' | 'y' | 'z')[] | null = null): void {
    if (!this.gripGroup) return;

    // Unit box — scaled per-frame to constant screen size
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00aa00,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(position.x, position.y, position.z);
    mesh.renderOrder = 1000;
    mesh.raycast = () => {};

    this.gripGroup.add(mesh);
    this.grips.push({ position, kind, anchor, scaleAxes, mesh });
  }

  /** Scale all grip cubes so they appear constant size on screen. */
  private scaleGripsToCamera(): void {
    const camera = (this.viewport.camera as any).getThreeCamera() as THREE.Camera;
    const camPos = camera.position;
    for (const grip of this.grips) {
      const dx = grip.position.x - camPos.x;
      const dy = grip.position.y - camPos.y;
      const dz = grip.position.z - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const s = Math.max(dist * 0.008, 0.01);
      grip.mesh.scale.set(s, s, s);
    }
  }

  private setGripColor(grip: Grip, color: number): void {
    (grip.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  private drawBoundingBoxLines(mn: Vec3, mx: Vec3): void {
    const dx = mx.x - mn.x;
    const dy = mx.y - mn.y;
    const dz = mx.z - mn.z;
    const threshold = 0.001;
    const color = { r: 1, g: 1, b: 0 };
    const ts = Date.now();

    if (dy < threshold) {
      // Flat on Y — draw 4 edges in XZ
      const y = mn.y;
      const c = [
        { x: mn.x, y, z: mn.z }, { x: mx.x, y, z: mn.z },
        { x: mx.x, y, z: mx.z }, { x: mn.x, y, z: mx.z },
      ];
      for (let i = 0; i < 4; i++) {
        const id = `scale-bb-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], c[(i + 1) % 4], color, false);
        this.bbLines.push(id);
      }
      // Dotted extension lines from corners
      for (let i = 0; i < 4; i++) {
        const dir = vec3.normalize(vec3.sub(c[i], this.bbCenter));
        const ext = vec3.add(c[i], vec3.mul(dir, 1.5));
        const id = `scale-ext-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], ext, { r: 0.3, g: 0.3, b: 0.3 }, true);
        this.bbLines.push(id);
      }
    } else if (dx < threshold) {
      // Flat on X
      const x = mn.x;
      const c = [
        { x, y: mn.y, z: mn.z }, { x, y: mx.y, z: mn.z },
        { x, y: mx.y, z: mx.z }, { x, y: mn.y, z: mx.z },
      ];
      for (let i = 0; i < 4; i++) {
        const id = `scale-bb-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], c[(i + 1) % 4], color, false);
        this.bbLines.push(id);
      }
      for (let i = 0; i < 4; i++) {
        const dir = vec3.normalize(vec3.sub(c[i], this.bbCenter));
        const ext = vec3.add(c[i], vec3.mul(dir, 1.5));
        const id = `scale-ext-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], ext, { r: 0.3, g: 0.3, b: 0.3 }, true);
        this.bbLines.push(id);
      }
    } else if (dz < threshold) {
      // Flat on Z
      const z = mn.z;
      const c = [
        { x: mn.x, y: mn.y, z }, { x: mx.x, y: mn.y, z },
        { x: mx.x, y: mx.y, z }, { x: mn.x, y: mx.y, z },
      ];
      for (let i = 0; i < 4; i++) {
        const id = `scale-bb-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], c[(i + 1) % 4], color, false);
        this.bbLines.push(id);
      }
      for (let i = 0; i < 4; i++) {
        const dir = vec3.normalize(vec3.sub(c[i], this.bbCenter));
        const ext = vec3.add(c[i], vec3.mul(dir, 1.5));
        const id = `scale-ext-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], ext, { r: 0.3, g: 0.3, b: 0.3 }, true);
        this.bbLines.push(id);
      }
    } else {
      // 3D box — 12 edges
      const c = [
        { x: mn.x, y: mn.y, z: mn.z }, { x: mx.x, y: mn.y, z: mn.z },
        { x: mx.x, y: mn.y, z: mx.z }, { x: mn.x, y: mn.y, z: mx.z },
        { x: mn.x, y: mx.y, z: mn.z }, { x: mx.x, y: mx.y, z: mn.z },
        { x: mx.x, y: mx.y, z: mx.z }, { x: mn.x, y: mx.y, z: mx.z },
      ];
      const edges = [
        [0,1],[1,2],[2,3],[3,0], // bottom
        [4,5],[5,6],[6,7],[7,4], // top
        [0,4],[1,5],[2,6],[3,7], // verticals
      ];
      for (let i = 0; i < edges.length; i++) {
        const id = `scale-bb-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[edges[i][0]], c[edges[i][1]], color, false);
        this.bbLines.push(id);
      }
      // Extension lines from 8 corners
      for (let i = 0; i < 8; i++) {
        const dir = vec3.normalize(vec3.sub(c[i], this.bbCenter));
        const ext = vec3.add(c[i], vec3.mul(dir, 1.0));
        const id = `scale-ext-${ts}-${i}`;
        this.viewport.renderer.addGuideLine(id, c[i], ext, { r: 0.3, g: 0.3, b: 0.3 }, true);
        this.bbLines.push(id);
      }
    }
  }

  private updateGripPositions(): void {
    // Recompute bounding box from current (scaled) vertex positions
    const bb = this.computeBoundingBox();
    const mn = bb.min;
    const mx = bb.max;
    this.bbCenter = { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 };

    const dx = mx.x - mn.x;
    const dy = mx.y - mn.y;
    const dz = mx.z - mn.z;
    const threshold = 0.001;

    let positions: Vec3[];

    if (dy < threshold) {
      const y = mn.y;
      const c = [
        { x: mn.x, y, z: mn.z }, { x: mx.x, y, z: mn.z },
        { x: mx.x, y, z: mx.z }, { x: mn.x, y, z: mx.z },
      ];
      positions = [
        ...c,
        vec3.lerp(c[0], c[1], 0.5), vec3.lerp(c[1], c[2], 0.5),
        vec3.lerp(c[2], c[3], 0.5), vec3.lerp(c[3], c[0], 0.5),
        this.bbCenter,
      ];
    } else if (dx < threshold) {
      const x = mn.x;
      const c = [
        { x, y: mn.y, z: mn.z }, { x, y: mx.y, z: mn.z },
        { x, y: mx.y, z: mx.z }, { x, y: mn.y, z: mx.z },
      ];
      positions = [
        ...c,
        vec3.lerp(c[0], c[1], 0.5), vec3.lerp(c[1], c[2], 0.5),
        vec3.lerp(c[2], c[3], 0.5), vec3.lerp(c[3], c[0], 0.5),
        this.bbCenter,
      ];
    } else if (dz < threshold) {
      const z = mn.z;
      const c = [
        { x: mn.x, y: mn.y, z }, { x: mx.x, y: mn.y, z },
        { x: mx.x, y: mx.y, z }, { x: mn.x, y: mx.y, z },
      ];
      positions = [
        ...c,
        vec3.lerp(c[0], c[1], 0.5), vec3.lerp(c[1], c[2], 0.5),
        vec3.lerp(c[2], c[3], 0.5), vec3.lerp(c[3], c[0], 0.5),
        this.bbCenter,
      ];
    } else {
      const c = [
        { x: mn.x, y: mn.y, z: mn.z }, { x: mx.x, y: mn.y, z: mn.z },
        { x: mx.x, y: mn.y, z: mx.z }, { x: mn.x, y: mn.y, z: mx.z },
        { x: mn.x, y: mx.y, z: mn.z }, { x: mx.x, y: mx.y, z: mn.z },
        { x: mx.x, y: mx.y, z: mx.z }, { x: mn.x, y: mx.y, z: mx.z },
      ];
      positions = [...c, this.bbCenter];
    }

    for (let i = 0; i < this.grips.length && i < positions.length; i++) {
      const g = this.grips[i];
      g.position = positions[i];
      g.mesh.position.set(positions[i].x, positions[i].y, positions[i].z);
    }
  }

  private findNearestGrip(screenX: number, screenY: number): Grip | null {
    const camera = (this.viewport.camera as any).getThreeCamera() as THREE.Camera;
    const w = this.viewport.getWidth();
    const h = this.viewport.getHeight();
    const threshold = 15; // pixels

    let best: Grip | null = null;
    let bestDist = threshold;

    for (const grip of this.grips) {
      const v = new THREE.Vector3(grip.position.x, grip.position.y, grip.position.z);
      v.project(camera);
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - screenX, sy - screenY);
      if (d < bestDist) { bestDist = d; best = grip; }
    }

    return best;
  }

  private clearGrips(): void {
    // Remove grip meshes
    if (this.gripGroup) {
      const overlayScene = (this.viewport.renderer as any).getOverlayScene?.() as THREE.Scene | undefined;
      if (overlayScene) overlayScene.remove(this.gripGroup);
      this.gripGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.gripGroup = null;
    }

    // Remove bounding box guide lines
    for (const id of this.bbLines) {
      this.viewport.renderer.removeGuideLine(id);
    }
    this.bbLines = [];
    this.grips = [];
    this.hoveredGrip = null;
  }
}
