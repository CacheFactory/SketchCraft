// @archigraph tool.base
// Abstract base class for all DraftDown tools

import { Vec3, Plane } from '../../src/core/types';
import type { ToolCategory, ToolPhase } from '../../src/core/types';
import type {
  ITool, ToolMouseEvent, ToolKeyEvent, ToolPreview, ToolEventNeeds,
  IModelDocument, IViewport, IInferenceEngine,
} from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { toInternal, toDisplay, formatDistance, getCurrentUnit } from '../../src/core/units';
import { customAxes } from '../tool.axes/CustomAxes';

/** Named drawing planes that arrow keys cycle through. */
export type DrawingPlaneAxis = 'ground' | 'red' | 'green' | 'blue';

/** Get the plane normal for an axis, respecting custom axes orientation. */
function getPlaneNormal(axis: DrawingPlaneAxis): Vec3 {
  return customAxes.getPlaneNormal(axis);
}

function getPlaneLabelSuffix(): string {
  return customAxes.isCustom ? ' (custom)' : '';
}

export const DRAWING_PLANES: Record<DrawingPlaneAxis, { label: string; color: string }> = {
  ground: { label: 'Ground (XZ)', color: '' },
  red:    { label: 'Red (YZ)',    color: 'red' },
  green:  { label: 'Green (XZ)',  color: 'green' },
  blue:   { label: 'Blue (XY)',   color: 'blue' },
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
    const container = document.querySelector('.viewport-container') as HTMLElement;
    if (container) container.style.cursor = 'crosshair';
  }

  deactivate(): void {
    this.phase = 'idle';
    this.vcbValue = '';
    this.statusText = '';
    // Reset cursor to crosshair (tools may set inline cursor styles)
    const container = document.querySelector('.viewport-container') as HTMLElement;
    if (container) container.style.cursor = 'crosshair';
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

  /**
   * Default event needs derived from tool category and phase.
   * Override in specific tools that differ from the default.
   */
  getEventNeeds(phase: ToolPhase): ToolEventNeeds {
    const isActive = phase === 'active' || phase === 'drawing';
    const isDrawOrMeasure = this.category === 'draw' || this.category === 'measure' || this.category === 'construct';
    return {
      snap: isDrawOrMeasure,  // Snap always on for draw/measure tools (first point too)
      raycast: isActive,
      edgeRaycast: false,
      liveSyncOnMove: false,
      mutatesOnClick: this.category !== 'navigate',
    };
  }

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

  /** Parse VCB input as a display-unit number and convert to internal (meters). Returns NaN on failure. */
  protected parseDistance(value: string): number {
    const v = parseFloat(value.trim());
    if (isNaN(v)) return NaN;
    return toInternal(v, getCurrentUnit());
  }

  /** Parse VCB input as comma-separated display-unit numbers, converted to internal. */
  protected parseDimensions(value: string): number[] {
    return value.split(',').map(s => {
      const v = parseFloat(s.trim());
      return isNaN(v) ? NaN : toInternal(v, getCurrentUnit());
    });
  }

  /** Format an internal distance for VCB display in current units. */
  protected formatDist(internalValue: number): string {
    return formatDistance(internalValue, getCurrentUnit());
  }

  /** Begin an undo transaction. Also snapshots dimension state. */
  protected beginTransaction(name: string): void {
    const { dimensionStore } = require('../tool.dimension/DimensionStore');
    dimensionStore.pushSnapshot();
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
    const normal = getPlaneNormal(this.drawingPlaneAxis);
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
      this.setStatus(`Drawing plane: ${info.label}${getPlaneLabelSuffix()}. ${this.statusText.replace(/Drawing plane:.*?\. /, '')}`);
    }
    return changed;
  }

  // ── Axis locking ────────────────────────────────────────────

  /** Current axis lock: 'x' | 'y' | 'z' | null */
  protected axisLock: 'x' | 'y' | 'z' | null = null;

  /**
   * Handle arrow keys for axis locking.
   * Up=Y (green/vertical), Right=X (red), Left=Z (blue), Down=unlock.
   * Returns true if an arrow key was handled.
   */
  protected handleArrowKeyAxisLock(event: ToolKeyEvent): boolean {
    switch (event.key) {
      case 'ArrowUp':
        this.axisLock = this.axisLock === 'y' ? null : 'y';
        break;
      case 'ArrowRight':
        this.axisLock = this.axisLock === 'x' ? null : 'x';
        break;
      case 'ArrowLeft':
        this.axisLock = this.axisLock === 'z' ? null : 'z';
        break;
      case 'ArrowDown':
        this.axisLock = null;
        break;
      default:
        return false;
    }
    return true;
  }

  /** Get a status string describing the current axis lock state. */
  protected getAxisLockStatus(): string {
    if (!this.axisLock) return 'Axis unlocked. Free movement.';
    const axisNames = { x: 'Red (X)', y: 'Green (Y) — vertical', z: 'Blue (Z)' };
    return `Locked to ${axisNames[this.axisLock]} axis.`;
  }

  /**
   * Apply axis lock: constrain the point to move only along the locked axis
   * from an anchor point. Respects custom axes orientation.
   */
  protected applyAxisLock(point: Vec3, anchor: Vec3): Vec3 {
    if (!this.axisLock) return point;
    const axisDir: Vec3 = customAxes.getAxisDirection(this.axisLock);
    const offset = vec3.sub(point, anchor);
    const projLen = vec3.dot(offset, axisDir);
    return vec3.add(anchor, vec3.mul(axisDir, projLen));
  }

  /**
   * Project a camera ray onto an axis line from an anchor point.
   * Returns the closest point on the axis to the ray.
   */
  protected projectRayOntoAxis(ray: { origin: Vec3; direction: Vec3 }, anchor: Vec3, axis: 'x' | 'y' | 'z'): Vec3 {
    const axisDir: Vec3 = customAxes.getAxisDirection(axis);
    const w = vec3.sub(anchor, ray.origin);
    const a = vec3.dot(ray.direction, ray.direction);
    const b = vec3.dot(ray.direction, axisDir);
    const c = vec3.dot(axisDir, axisDir);
    const d = vec3.dot(ray.direction, w);
    const e = vec3.dot(axisDir, w);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-10) return anchor;
    const s = (a * e - b * d) / denom;
    return vec3.add(anchor, vec3.mul(axisDir, s));
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
