// @archigraph svc.material_manager
// Material CRUD and face assignment with PBR properties

import { v4 as uuid } from 'uuid';
import { SimpleEventEmitter } from '../core/events';
import { MaterialDef } from '../core/types';
import { IMaterialManager, IGeometryEngine } from '../core/interfaces';

// ─── Event map ───────────────────────────────────────────────────

type MaterialEvents = {
  'changed': [];
};

// ─── Default material ────────────────────────────────────────────

const DEFAULT_MATERIAL_ID = '__default__';

function createDefaultMaterial(): MaterialDef {
  return {
    id: DEFAULT_MATERIAL_ID,
    name: 'Default Material',
    color: { r: 0.75, g: 0.75, b: 0.75, a: 1 },
    opacity: 1,
    roughness: 0.5,
    metalness: 0,
  };
}

// ─── MaterialManager ─────────────────────────────────────────────

export class MaterialManager implements IMaterialManager {
  materials: Map<string, MaterialDef>;
  defaultMaterial: MaterialDef;

  private emitter = new SimpleEventEmitter<MaterialEvents>();
  private geometryEngine: IGeometryEngine | null;

  // Maps faceId -> { front: materialId, back: materialId }
  private faceAssignments: Map<string, { front: string; back: string }> = new Map();

  constructor(geometryEngine?: IGeometryEngine) {
    this.defaultMaterial = createDefaultMaterial();
    this.materials = new Map();
    this.materials.set(this.defaultMaterial.id, this.defaultMaterial);
    this.geometryEngine = geometryEngine ?? null;
  }

  // ── CRUD ─────────────────────────────────────────────────────

  addMaterial(mat: Omit<MaterialDef, 'id'>): MaterialDef {
    const material: MaterialDef = { id: uuid(), ...mat };
    this.materials.set(material.id, material);
    this.emitter.emit('changed');
    return material;
  }

  removeMaterial(id: string): void {
    if (id === DEFAULT_MATERIAL_ID) return; // cannot remove default
    if (!this.materials.has(id)) return;

    // Reassign faces using this material to default
    for (const [faceId, assignment] of this.faceAssignments) {
      if (assignment.front === id) {
        assignment.front = DEFAULT_MATERIAL_ID;
      }
      if (assignment.back === id) {
        assignment.back = DEFAULT_MATERIAL_ID;
      }
    }

    this.materials.delete(id);
    this.emitter.emit('changed');
  }

  updateMaterial(id: string, updates: Partial<MaterialDef>): void {
    const mat = this.materials.get(id);
    if (!mat) return;

    // Apply updates, never overwrite id
    const { id: _ignoreId, ...rest } = updates;
    Object.assign(mat, rest);
    this.emitter.emit('changed');
  }

  getMaterial(id: string): MaterialDef | undefined {
    return this.materials.get(id);
  }

  getAllMaterials(): MaterialDef[] {
    return Array.from(this.materials.values());
  }

  // ── Face assignment ──────────────────────────────────────────

  applyToFace(faceId: string, materialId: string, backFace = false): void {
    if (!this.materials.has(materialId)) return;

    let assignment = this.faceAssignments.get(faceId);
    if (!assignment) {
      assignment = { front: DEFAULT_MATERIAL_ID, back: DEFAULT_MATERIAL_ID };
      this.faceAssignments.set(faceId, assignment);
    }

    if (backFace) {
      assignment.back = materialId;
    } else {
      assignment.front = materialId;
    }

    // Also update the geometry engine face materialIndex if available
    if (this.geometryEngine) {
      const face = this.geometryEngine.getFace(faceId);
      if (face) {
        const matArray = Array.from(this.materials.keys());
        const idx = matArray.indexOf(materialId);
        if (backFace) {
          face.backMaterialIndex = idx >= 0 ? idx : 0;
        } else {
          face.materialIndex = idx >= 0 ? idx : 0;
        }
      }
    }

    this.emitter.emit('changed');
  }

  getFaceMaterial(faceId: string): MaterialDef {
    const assignment = this.faceAssignments.get(faceId);
    if (!assignment) return this.defaultMaterial;

    return this.materials.get(assignment.front) ?? this.defaultMaterial;
  }

  // ── Reset ────────────────────────────────────────────────────

  reset(): void {
    this.materials.clear();
    this.faceAssignments.clear();
    this.defaultMaterial = createDefaultMaterial();
    this.materials.set(this.defaultMaterial.id, this.defaultMaterial);
    this.emitter.emit('changed');
  }

  // ── Events ───────────────────────────────────────────────────

  on(event: 'changed', handler: () => void): void {
    this.emitter.on(event, handler);
  }

  off(event: 'changed', handler: () => void): void {
    this.emitter.off(event, handler);
  }
}
