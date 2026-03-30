// @archigraph tool.rotate
// Rotate tool: shows protractor-style handles on selection bounding box.
// Arrow keys lock rotation axis (Up=green/Y, Right=red/X, Left=blue/Z).
// Click handle → drag to rotate with live preview. Type degrees for exact angle.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';
import * as THREE from 'three';

interface RotateHandle {
  position: Vec3;
  mesh: THREE.Mesh;
  label: string;
}

export class RotateTool extends BaseTool {
  readonly id = 'tool.rotate';
  readonly name = 'Rotate';
  readonly icon = 'rotate';
  readonly shortcut = 'Q';
  readonly category = 'modify' as const;
  readonly cursor = 'crosshair';

  private center: Vec3 | null = null;
  private startAngleRef: Vec3 | null = null;
  private currentAngle = 0;
  private step: 0 | 1 | 2 = 0;
  private vertexIds: string[] = [];
  private originalPositions = new Map<string, Vec3>();
  private rotationAxis: Vec3 = { x: 0, y: 1, z: 0 };
  private axisName: 'green' | 'red' | 'blue' = 'green';

  // Handles & visual overlay
  private handles: RotateHandle[] = [];
  private hoveredHandle: RotateHandle | null = null;
  private handleGroup: THREE.Group | null = null;
  private protractorLines: string[] = [];

  // ── Lifecycle ─────────────────────────────────────────

  activate(): void {
    super.activate();
    this.reset();
    if (!this.document.selection.isEmpty) {
      this.gatherVertices();
      if (this.vertexIds.length > 0) {
        this.showHandles();
        this.setStatus(`Click a handle to set rotation center. Arrow keys change axis (${this.axisLabel()}).`);
      } else {
        this.setStatus('Select a face or edge first.');
      }
    } else {
      this.setStatus('Select geometry, then activate Rotate.');
    }
  }

  deactivate(): void {
    if (this.step > 0) { this.restoreOriginal(); this.abortTransaction(); }
    this.clearHandles();
    this.reset();
    super.deactivate();
  }

  // ── Mouse events ──────────────────────────────────────

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    if (this.step === 0) {
      // If nothing selected, try clicking to select
      if (this.vertexIds.length === 0) {
        if (event.hitEntityId) {
          this.document.selection.select(event.hitEntityId);
          this.gatherVertices();
          if (this.vertexIds.length > 0) {
            this.showHandles();
            this.setStatus(`Click a handle to set rotation center. Arrow keys change axis (${this.axisLabel()}).`);
          }
        }
        return;
      }

      // Check if a handle was clicked
      const handle = this.findNearestHandle(event.screenX, event.screenY);
      if (handle) {
        this.center = { ...handle.position };
      } else {
        // Click on arbitrary point as center
        this.center = point;
      }

      this.beginTransaction('Rotate');
      this.saveOriginal();
      this.clearHandles();
      this.drawProtractor();
      this.step = 1;
      this.setPhase('drawing');
      this.setStatus('Click to set start angle reference.');
    } else if (this.step === 1) {
      this.startAngleRef = point;
      this.step = 2;
      this.setStatus('Drag to rotate. Type degrees for exact angle.');
    } else if (this.step === 2) {
      this.clearProtractor();
      this.commitTransaction();
      this.reset();
      this.gatherVertices();
      if (this.vertexIds.length > 0) this.showHandles();
      this.setStatus('Rotation complete.');
    }
  }

  onMouseMove(event: ToolMouseEvent): void {
    // Keep handles at constant screen size
    if (this.handles.length > 0) this.scaleHandlesToCamera();

    if (this.step === 0) {
      // Highlight handle under cursor
      const handle = this.findNearestHandle(event.screenX, event.screenY);
      if (handle !== this.hoveredHandle) {
        if (this.hoveredHandle) this.setHandleColor(this.hoveredHandle, 0x00aa00);
        this.hoveredHandle = handle;
        if (handle) this.setHandleColor(handle, 0xffff00);
      }
      return;
    }

    if (this.step !== 2 || !this.center || !this.startAngleRef) return;
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    const v1 = vec3.normalize(vec3.sub(this.startAngleRef, this.center));
    const v2 = vec3.normalize(vec3.sub(point, this.center));
    const dot = Math.max(-1, Math.min(1, vec3.dot(v1, v2)));
    const cross = vec3.cross(v1, v2);
    const sign = vec3.dot(cross, this.rotationAxis) >= 0 ? 1 : -1;
    this.currentAngle = sign * Math.acos(dot);
    this.setVCBValue(`${(this.currentAngle * 180 / Math.PI).toFixed(1)}\u00b0`);
    this.applyRotation(this.currentAngle);
  }

  // ── Keyboard events ───────────────────────────────────

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      if (this.step > 0) { this.restoreOriginal(); this.abortTransaction(); this.clearProtractor(); }
      this.clearHandles();
      this.reset();
      this.gatherVertices();
      if (this.vertexIds.length > 0) this.showHandles();
      this.setStatus('Rotation cancelled.');
      return;
    }

    // Arrow keys change rotation axis
    const prevAxis = this.axisName;
    switch (event.key) {
      case 'ArrowUp':
        this.axisName = this.axisName === 'green' ? 'green' : 'green';
        this.axisName = prevAxis === 'green' ? 'green' : 'green';
        // Toggle: if already green, stay green (default). Otherwise switch to green.
        this.setAxis('green');
        break;
      case 'ArrowRight':
        this.setAxis(prevAxis === 'red' ? 'green' : 'red');
        break;
      case 'ArrowLeft':
        this.setAxis(prevAxis === 'blue' ? 'green' : 'blue');
        break;
      case 'ArrowDown':
        this.setAxis('green');
        break;
      default:
        return;
    }

    // If we're in step 0, refresh handles for new axis
    if (this.step === 0 && this.vertexIds.length > 0) {
      this.showHandles();
      this.setStatus(`Rotation axis: ${this.axisLabel()}. Click a handle to set center.`);
    } else if (this.step >= 1) {
      // If mid-rotation, update the protractor visual and re-apply
      this.clearProtractor();
      this.drawProtractor();
      if (this.step === 2) {
        this.applyRotation(this.currentAngle);
      }
      this.setStatus(`Rotation axis: ${this.axisLabel()}. ${this.step === 1 ? 'Click start angle.' : 'Drag to rotate.'}`);
    }
  }

  // ── VCB ───────────────────────────────────────────────

  onVCBInput(value: string): void {
    if (this.step !== 2) return;
    const deg = this.parseDistance(value.replace('\u00b0', ''));
    if (isNaN(deg)) return;
    this.applyRotation(deg * Math.PI / 180);
    this.clearProtractor();
    this.commitTransaction();
    this.reset();
    this.gatherVertices();
    if (this.vertexIds.length > 0) this.showHandles();
    this.setStatus('Rotation complete.');
  }

  getVCBLabel(): string { return this.step === 2 ? 'Angle' : ''; }
  getPreview(): ToolPreview | null { return null; }

  // ── Axis management ───────────────────────────────────

  private setAxis(name: 'green' | 'red' | 'blue'): void {
    this.axisName = name;
    switch (name) {
      case 'green': this.rotationAxis = { x: 0, y: 1, z: 0 }; break;
      case 'red':   this.rotationAxis = { x: 1, y: 0, z: 0 }; break;
      case 'blue':  this.rotationAxis = { x: 0, y: 0, z: 1 }; break;
    }
  }

  private axisLabel(): string {
    switch (this.axisName) {
      case 'green': return 'Green (Y)';
      case 'red':   return 'Red (X)';
      case 'blue':  return 'Blue (Z)';
    }
  }

  private axisColor(): number {
    switch (this.axisName) {
      case 'green': return 0x00cc00;
      case 'red':   return 0xcc0000;
      case 'blue':  return 0x0000cc;
    }
  }

  // ── State management ──────────────────────────────────

  private reset(): void {
    this.center = null;
    this.startAngleRef = null;
    this.currentAngle = 0;
    this.step = 0;
    this.vertexIds = [];
    this.originalPositions.clear();
    this.setPhase('idle');
    this.setVCBValue('');
  }

  private gatherVertices(): void {
    this.vertexIds = [];
    const seen = new Set<string>();
    for (const eid of this.resolveSelectedEntityIds()) {
      const f = this.document.geometry.getFace(eid);
      if (f) {
        for (const vid of f.vertexIds) if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); }
        continue;
      }
      const e = this.document.geometry.getEdge(eid);
      if (e) {
        for (const vid of [e.startVertexId, e.endVertexId]) if (!seen.has(vid)) { seen.add(vid); this.vertexIds.push(vid); }
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

  private applyRotation(angle: number): void {
    if (!this.center) return;
    const cos = Math.cos(angle), sin = Math.sin(angle), ax = this.rotationAxis;
    for (const [vid, orig] of this.originalPositions) {
      const v = this.document.geometry.getVertex(vid);
      if (!v) continue;
      const rel = vec3.sub(orig, this.center);
      const d = vec3.dot(rel, ax);
      const cr = vec3.cross(ax, rel);
      const rot = vec3.add(vec3.add(vec3.mul(rel, cos), vec3.mul(cr, sin)), vec3.mul(ax, d * (1 - cos)));
      const fin = vec3.add(this.center, rot);
      v.position.x = fin.x; v.position.y = fin.y; v.position.z = fin.z;
    }
  }

  // ── Bounding box ──────────────────────────────────────

  private computeBoundingBox(): { min: Vec3; max: Vec3; center: Vec3 } {
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
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    };
  }

  // ── Handle system ─────────────────────────────────────

  private showHandles(): void {
    this.clearHandles();

    const bb = this.computeBoundingBox();
    const mn = bb.min, mx = bb.max, ct = bb.center;

    const overlayScene = (this.viewport.renderer as any).getOverlayScene?.() as THREE.Scene | undefined;
    if (!overlayScene) return;

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = 'rotate-handles';
    this.handleGroup.renderOrder = 999;

    // Place handles at bounding box center + face centers + edge midpoints
    // depending on the rotation axis
    const handlePositions: Array<{ pos: Vec3; label: string }> = [];

    // Center handle (always present)
    handlePositions.push({ pos: ct, label: 'center' });

    // Face center handles perpendicular to rotation axis
    if (this.axisName === 'green') {
      // Rotating around Y: put handles on XZ face centers + corners
      handlePositions.push({ pos: { x: mn.x, y: ct.y, z: ct.z }, label: '-X face' });
      handlePositions.push({ pos: { x: mx.x, y: ct.y, z: ct.z }, label: '+X face' });
      handlePositions.push({ pos: { x: ct.x, y: ct.y, z: mn.z }, label: '-Z face' });
      handlePositions.push({ pos: { x: ct.x, y: ct.y, z: mx.z }, label: '+Z face' });
      // Corners in XZ plane at mid Y
      handlePositions.push({ pos: { x: mn.x, y: ct.y, z: mn.z }, label: 'corner' });
      handlePositions.push({ pos: { x: mx.x, y: ct.y, z: mn.z }, label: 'corner' });
      handlePositions.push({ pos: { x: mx.x, y: ct.y, z: mx.z }, label: 'corner' });
      handlePositions.push({ pos: { x: mn.x, y: ct.y, z: mx.z }, label: 'corner' });
    } else if (this.axisName === 'red') {
      // Rotating around X: put handles on YZ face centers + corners
      handlePositions.push({ pos: { x: ct.x, y: mn.y, z: ct.z }, label: '-Y face' });
      handlePositions.push({ pos: { x: ct.x, y: mx.y, z: ct.z }, label: '+Y face' });
      handlePositions.push({ pos: { x: ct.x, y: ct.y, z: mn.z }, label: '-Z face' });
      handlePositions.push({ pos: { x: ct.x, y: ct.y, z: mx.z }, label: '+Z face' });
      handlePositions.push({ pos: { x: ct.x, y: mn.y, z: mn.z }, label: 'corner' });
      handlePositions.push({ pos: { x: ct.x, y: mx.y, z: mn.z }, label: 'corner' });
      handlePositions.push({ pos: { x: ct.x, y: mx.y, z: mx.z }, label: 'corner' });
      handlePositions.push({ pos: { x: ct.x, y: mn.y, z: mx.z }, label: 'corner' });
    } else {
      // Rotating around Z: put handles on XY face centers + corners
      handlePositions.push({ pos: { x: mn.x, y: ct.y, z: ct.z }, label: '-X face' });
      handlePositions.push({ pos: { x: mx.x, y: ct.y, z: ct.z }, label: '+X face' });
      handlePositions.push({ pos: { x: ct.x, y: mn.y, z: ct.z }, label: '-Y face' });
      handlePositions.push({ pos: { x: ct.x, y: mx.y, z: ct.z }, label: '+Y face' });
      handlePositions.push({ pos: { x: mn.x, y: mn.y, z: ct.z }, label: 'corner' });
      handlePositions.push({ pos: { x: mx.x, y: mn.y, z: ct.z }, label: 'corner' });
      handlePositions.push({ pos: { x: mx.x, y: mx.y, z: ct.z }, label: 'corner' });
      handlePositions.push({ pos: { x: mn.x, y: mx.y, z: ct.z }, label: 'corner' });
    }

    for (const { pos, label } of handlePositions) {
      this.addHandle(pos, label);
    }

    overlayScene.add(this.handleGroup);

    // Draw axis line through center
    const axisExtent = Math.max(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z) * 0.8;
    const axLine1 = vec3.add(ct, vec3.mul(this.rotationAxis, axisExtent));
    const axLine2 = vec3.add(ct, vec3.mul(this.rotationAxis, -axisExtent));
    const axColor = this.axisName === 'red' ? { r: 0.8, g: 0, b: 0 }
                  : this.axisName === 'blue' ? { r: 0, g: 0, b: 0.8 }
                  : { r: 0, g: 0.8, b: 0 };
    const ts = Date.now();
    const axId = `rotate-axis-${ts}`;
    this.viewport.renderer.addGuideLine(axId, axLine1, axLine2, axColor, true);
    this.protractorLines.push(axId);

    this.scaleHandlesToCamera();
  }

  private addHandle(position: Vec3, label: string): void {
    if (!this.handleGroup) return;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00aa00,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(position.x, position.y, position.z);
    mesh.renderOrder = 1000;
    mesh.raycast = () => {};

    this.handleGroup.add(mesh);
    this.handles.push({ position, mesh, label });
  }

  private scaleHandlesToCamera(): void {
    const camera = (this.viewport.camera as any).getThreeCamera() as THREE.Camera;
    const camPos = camera.position;
    for (const handle of this.handles) {
      const dx = handle.position.x - camPos.x;
      const dy = handle.position.y - camPos.y;
      const dz = handle.position.z - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const s = Math.max(dist * 0.008, 0.01);
      handle.mesh.scale.set(s, s, s);
    }
  }

  private setHandleColor(handle: RotateHandle, color: number): void {
    (handle.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  private findNearestHandle(screenX: number, screenY: number): RotateHandle | null {
    const camera = (this.viewport.camera as any).getThreeCamera() as THREE.Camera;
    const w = this.viewport.getWidth();
    const h = this.viewport.getHeight();
    const threshold = 15;

    let best: RotateHandle | null = null;
    let bestDist = threshold;

    for (const handle of this.handles) {
      const v = new THREE.Vector3(handle.position.x, handle.position.y, handle.position.z);
      v.project(camera);
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - screenX, sy - screenY);
      if (d < bestDist) { bestDist = d; best = handle; }
    }

    return best;
  }

  // ── Protractor visual ─────────────────────────────────

  private drawProtractor(): void {
    if (!this.center) return;
    const ts = Date.now();

    // Draw rotation axis through center
    const axisExtent = 2.0;
    const axLine1 = vec3.add(this.center, vec3.mul(this.rotationAxis, axisExtent));
    const axLine2 = vec3.add(this.center, vec3.mul(this.rotationAxis, -axisExtent));
    const axColor = this.axisName === 'red' ? { r: 0.8, g: 0, b: 0 }
                  : this.axisName === 'blue' ? { r: 0, g: 0, b: 0.8 }
                  : { r: 0, g: 0.8, b: 0 };
    const axId = `rotate-protractor-axis-${ts}`;
    this.viewport.renderer.addGuideLine(axId, axLine1, axLine2, axColor, false);
    this.protractorLines.push(axId);

    // Draw a circle (protractor) in the rotation plane
    const radius = 1.0;
    const segments = 36;
    // Find two perpendicular vectors in the rotation plane
    const up = this.rotationAxis;
    let tangent: Vec3;
    if (Math.abs(up.x) < 0.9) {
      tangent = vec3.normalize(vec3.cross(up, { x: 1, y: 0, z: 0 }));
    } else {
      tangent = vec3.normalize(vec3.cross(up, { x: 0, y: 1, z: 0 }));
    }
    const bitangent = vec3.normalize(vec3.cross(up, tangent));

    const circleColor = { r: 0.5, g: 0.5, b: 0.5 };
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      const p1 = vec3.add(this.center, vec3.add(vec3.mul(tangent, Math.cos(a1) * radius), vec3.mul(bitangent, Math.sin(a1) * radius)));
      const p2 = vec3.add(this.center, vec3.add(vec3.mul(tangent, Math.cos(a2) * radius), vec3.mul(bitangent, Math.sin(a2) * radius)));
      const id = `rotate-circle-${ts}-${i}`;
      this.viewport.renderer.addGuideLine(id, p1, p2, circleColor, true);
      this.protractorLines.push(id);
    }
  }

  private clearProtractor(): void {
    for (const id of this.protractorLines) {
      this.viewport.renderer.removeGuideLine(id);
    }
    this.protractorLines = [];
  }

  private clearHandles(): void {
    if (this.handleGroup) {
      const overlayScene = (this.viewport.renderer as any).getOverlayScene?.() as THREE.Scene | undefined;
      if (overlayScene) overlayScene.remove(this.handleGroup);
      this.handleGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.handleGroup = null;
    }
    this.clearProtractor();
    this.handles = [];
    this.hoveredHandle = null;
  }
}
