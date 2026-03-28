// @archigraph tool.base
// Abstract base class for all SketchCraft tools

import { Vec3, Plane } from '../../src/core/types';
import type { ToolCategory, ToolPhase } from '../../src/core/types';
import type {
  ITool, ToolMouseEvent, ToolKeyEvent, ToolPreview,
  IModelDocument, IViewport, IInferenceEngine,
} from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';

/** Named drawing planes that arrow keys cycle through. */
export type DrawingPlaneAxis = 'ground' | 'red' | 'green' | 'blue';

export const DRAWING_PLANES: Record<DrawingPlaneAxis, { normal: Vec3; label: string; color: string }> = {
  ground: { normal: { x: 0, y: 1, z: 0 }, label: 'Ground (XZ)', color: '' },
  red:    { normal: { x: 1, y: 0, z: 0 }, label: 'Red (YZ)',    color: 'red' },
  green:  { normal: { x: 0, y: 1, z: 0 }, label: 'Green (XZ)',  color: 'green' },
  blue:   { normal: { x: 0, y: 0, z: 1 }, label: 'Blue (XY)',   color: 'blue' },
};

export abstract class BaseTool implements ITool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: string;
  abstract readonly shortcut: string;
  abstract readonly category: ToolCategory;
  abstract readonly cursor: string;

  protected document: IModelDocument;
  protected viewport: IViewport;
  protected inference: IInferenceEngine;

  protected phase: ToolPhase = 'idle';
  protected vcbValue: string = '';
  protected statusText: string = '';

  /** Current drawing plane axis, changeable with arrow keys. */
  protected drawingPlaneAxis: DrawingPlaneAxis = 'ground';

  constructor(document: IModelDocument, viewport: IViewport, inference: IInferenceEngine) {
    this.document = document;
    this.viewport = viewport;
    this.inference = inference;
  }

  activate(): void {
    this.phase = 'idle';
    this.vcbValue = '';
    this.statusText = '';
    this.drawingPlaneAxis = 'ground';
  }

  deactivate(): void {
    this.phase = 'idle';
    this.vcbValue = '';
    this.statusText = '';
  }

  onMouseDown(_event: ToolMouseEvent): void {}
  onMouseMove(_event: ToolMouseEvent): void {}
  onMouseUp(_event: ToolMouseEvent): void {}
  onKeyDown(_event: ToolKeyEvent): void {}
  onKeyUp(_event: ToolKeyEvent): void {}
  onVCBInput(_value: string): void {}

  getStatusText(): string { return this.statusText; }
  getVCBLabel(): string { return ''; }
  getVCBValue(): string { return this.vcbValue; }
  getPreview(): ToolPreview | null { return null; }

  // ── Helpers ──────────────────────────────────────────────────

  protected setPhase(phase: ToolPhase): void {
    this.phase = phase;
  }

  protected setVCBValue(value: string): void {
    this.vcbValue = value;
  }

  protected setStatus(text: string): void {
    this.statusText = text;
  }

  /** Resolve the effective world point from an event, preferring inference snap. */
  protected resolvePoint(event: ToolMouseEvent): Vec3 | null {
    if (event.inference) return event.inference.point;
    return event.worldPoint;
  }

  /**
   * Standard point resolution for draw tools:
   * 1. If snapped (worldPoint matches a vertex), use it
   * 2. If axis locked, project ray onto locked axis
   * 3. Raycast onto drawing plane
   * 4. Fall back to ground plane worldPoint
   */
  protected getStandardDrawPoint(event: ToolMouseEvent, anchor?: Vec3): Vec3 | null {
    // Snapped worldPoint always wins
    if (event.worldPoint) return event.worldPoint;
    // Raycast onto drawing plane
    const planePoint = this.screenToDrawingPlane(event, anchor);
    if (planePoint) return planePoint;
    return null;
  }

  /**
   * Find an existing vertex at the given position, or create a new one.
   * Prevents duplicate vertices at the same location.
   */
  protected findOrCreateVertex(point: Vec3): { id: string } {
    const SNAP_DIST = 0.01;
    const mesh = this.document.geometry.getMesh();
    for (const [, v] of mesh.vertices) {
      if (vec3.distance(v.position, point) < SNAP_DIST) {
        return { id: v.id };
      }
    }
    return this.document.geometry.createVertex(point);
  }

  /** Parse VCB input as a single number. Returns NaN on failure. */
  protected parseDistance(value: string): number {
    return parseFloat(value.trim());
  }

  /** Parse VCB input as comma-separated numbers. */
  protected parseDimensions(value: string): number[] {
    return value.split(',').map(s => parseFloat(s.trim()));
  }

  /** Begin an undo transaction. */
  protected beginTransaction(name: string): void {
    this.document.history.beginTransaction(name);
  }

  /** Commit the current undo transaction. */
  protected commitTransaction(): void {
    this.document.history.commitTransaction();
  }

  /** Abort the current undo transaction. */
  protected abortTransaction(): void {
    this.document.history.abortTransaction();
  }

  /** Check if an entity can be edited in the current context (respects components). */
  protected isEditable(entityId: string): boolean {
    const sm = this.document.scene as any;
    return sm?.isEntityEditable ? sm.isEntityEditable(entityId) : true;
  }

  /**
   * Resolve selected entity IDs to actual face/edge IDs.
   * Component IDs are expanded to their member entity IDs.
   */
  protected resolveSelectedEntityIds(): string[] {
    const sm = this.document.scene as any;
    const result: string[] = [];
    for (const id of this.document.selection.state.entityIds) {
      // Check if it's a component ID
      if (sm?.components?.has(id)) {
        const comp = sm.components.get(id);
        if (comp) {
          for (const eid of comp.entityIds) result.push(eid);
        }
      } else {
        result.push(id);
      }
    }
    return result;
  }

  /**
   * Get the current drawing plane based on the selected axis and an anchor point.
   * The plane passes through the anchor point with the axis normal.
   */
  protected getDrawingPlane(anchor: Vec3): Plane {
    const info = DRAWING_PLANES[this.drawingPlaneAxis];
    const normal = info.normal;
    const distance = vec3.dot(anchor, normal);
    return { normal: { ...normal }, distance };
  }

  /**
   * Handle arrow key presses to change drawing plane.
   * Returns true if an arrow key was handled.
   */
  protected handleArrowKeyPlane(event: ToolKeyEvent): boolean {
    let changed = false;
    switch (event.key) {
      case 'ArrowUp':
        this.drawingPlaneAxis = this.drawingPlaneAxis === 'green' ? 'ground' : 'green';
        changed = true;
        break;
      case 'ArrowRight':
        this.drawingPlaneAxis = this.drawingPlaneAxis === 'red' ? 'ground' : 'red';
        changed = true;
        break;
      case 'ArrowLeft':
        this.drawingPlaneAxis = this.drawingPlaneAxis === 'blue' ? 'ground' : 'blue';
        changed = true;
        break;
      case 'ArrowDown':
        this.drawingPlaneAxis = 'ground';
        changed = true;
        break;
    }

    if (changed) {
      const info = DRAWING_PLANES[this.drawingPlaneAxis];
      this.setStatus(`Drawing plane: ${info.label}. ${this.statusText.replace(/Drawing plane:.*?\. /, '')}`);
    }
    return changed;
  }

  /**
   * Project a world point onto the current drawing plane.
   * If anchor is provided, the plane passes through the anchor.
   */
  protected projectOnDrawingPlane(point: Vec3, anchor?: Vec3): Vec3 {
    const plane = this.getDrawingPlane(anchor ?? { x: 0, y: 0, z: 0 });
    return vec3.projectOnPlane(point, plane);
  }

  /**
   * Cast a ray from screen coordinates and intersect with the current drawing plane.
   * More accurate than projectOnDrawingPlane for non-ground planes.
   */
  protected screenToDrawingPlane(event: ToolMouseEvent, anchor?: Vec3): Vec3 | null {
    const plane = this.getDrawingPlane(anchor ?? { x: 0, y: 0, z: 0 });
    const ray = this.viewport.camera.screenToRay(
      event.screenX, event.screenY,
      this.viewport.getWidth(), this.viewport.getHeight(),
    );

    // Ray-plane intersection
    const denom = vec3.dot(ray.direction, plane.normal);
    if (Math.abs(denom) < 1e-10) return null; // Parallel to plane

    const t = (plane.distance - vec3.dot(ray.origin, plane.normal)) / denom;
    if (t < 0) return null; // Behind camera

    return vec3.add(ray.origin, vec3.mul(ray.direction, t));
  }
}
