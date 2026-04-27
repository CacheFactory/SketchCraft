// @archigraph svc.model_document
// Top-level document: owns all managers, metadata, serialization, dirty tracking

import { SimpleEventEmitter } from '../../src/core/events';
import { LengthUnit } from '../../src/core/types';
import {
  IModelDocument, DocumentMetadata,
  ISceneManager, ISelectionManager, IHistoryManager,
  IMaterialManager, IGeometryEngine,
} from '../../src/core/interfaces';
import { SceneManager } from '../data.scene/SceneManager';
import { SelectionManager } from '../data.selection/SelectionManager';
import { HistoryManager } from '../data.history/HistoryManager';
import { MaterialManager } from '../data.materials/MaterialManager';
import { GeometryEngine } from '../engine.geometry/GeometryEngine';

// ─── Event map ───────────────────────────────────────────────────

type DocumentEvents = {
  'dirty-changed': [boolean];
  'metadata-changed': [DocumentMetadata];
};

// ─── Serialization helpers ───────────────────────────────────────

const MAGIC = 0x534B4346; // 'SKCF' — DraftDown File
const VERSION = 1;

function encodeString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ─── ModelDocument ───────────────────────────────────────────────

export class ModelDocument implements IModelDocument {
  metadata: DocumentMetadata;
  dirty = false;
  filePath: string | null = null;

  scene: ISceneManager;
  selection: ISelectionManager;
  history: IHistoryManager;
  materials: IMaterialManager;
  geometry: IGeometryEngine;

  private emitter = new SimpleEventEmitter<DocumentEvents>();

  constructor(geometryEngine: IGeometryEngine) {
    this.geometry = geometryEngine;

    this.metadata = {
      name: 'Untitled',
      description: '',
      author: '',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      units: 'mm' as LengthUnit,
    };

    this.scene = new SceneManager();
    this.selection = new SelectionManager(this.scene, this.geometry);
    this.history = new HistoryManager();
    this.materials = new MaterialManager(this.geometry);

    // Wire up delta-based undo/redo — records mutations on mesh maps + material assignments
    (this.history as HistoryManager).setTrackedSources(
      (this.geometry as GeometryEngine).getInternalMesh(),
      this.materials as MaterialManager,
    );

    this.wireEvents();
  }

  /**
   * Listen to sub-manager changes to auto-mark dirty.
   */
  private wireEvents(): void {
    // Scene changes mark dirty
    this.scene.on('changed', () => {
      this.markDirty();
    });

    // Material changes mark dirty
    this.materials.on('changed', () => {
      this.markDirty();
    });

    // History changes mark dirty
    this.history.on('changed', () => {
      this.markDirty();
    });
  }

  // ── Dirty tracking ──────────────────────────────────────────

  markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.metadata.modifiedAt = Date.now();
      this.emitter.emit('dirty-changed', true);
    }
  }

  markClean(): void {
    if (this.dirty) {
      this.dirty = false;
      this.emitter.emit('dirty-changed', false);
    }
  }

  // ── New document ─────────────────────────────────────────────

  newDocument(): void {
    // Reset metadata
    this.metadata = {
      name: 'Untitled',
      description: '',
      author: '',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      units: 'mm' as LengthUnit,
    };

    // Reset geometry to empty
    this.geometry.deserialize(this.geometry.serialize());

    // Recreate scene and selection managers
    this.scene = new SceneManager();
    this.selection = new SelectionManager(this.scene, this.geometry);

    // Clear history and re-wire delta tracking to the new mesh
    this.history.clear();
    (this.history as HistoryManager).setTrackedSources(
      (this.geometry as GeometryEngine).getInternalMesh(),
      this.materials as MaterialManager,
    );

    // Reset materials (keep default)
    if (this.materials instanceof MaterialManager) {
      (this.materials as MaterialManager).reset();
    }

    this.filePath = null;
    this.dirty = false;

    this.wireEvents();
    this.emitter.emit('dirty-changed', false);
    this.emitter.emit('metadata-changed', { ...this.metadata });
  }

  // ── Serialization ────────────────────────────────────────────

  serialize(): ArrayBuffer {
    // Pack document state as JSON inside an ArrayBuffer with a header.
    const payload = {
      metadata: this.metadata,
      scene: {
        entities: (this.scene as SceneManager).getAllEntities(),
        rootId: this.scene.root.id,
        layers: Array.from(this.scene.layers.entries()),
        componentDefinitions: Array.from(this.scene.componentDefinitions.entries()),
        scenePages: this.scene.scenePages,
        editingContext: this.scene.editingContext,
      },
      materials: (this.materials as MaterialManager).getAllMaterials(),
    };

    const jsonBytes = encodeString(JSON.stringify(payload));

    // Geometry engine serializes its own mesh data
    const geometryBuffer = this.geometry.serialize();
    const geoBytes = new Uint8Array(geometryBuffer);

    // Header: magic(4) + version(4) + jsonLen(4) + geoLen(4) = 16 bytes
    const headerSize = 16;
    const totalSize = headerSize + jsonBytes.byteLength + geoBytes.byteLength;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    view.setUint32(0, MAGIC, false);
    view.setUint32(4, VERSION, false);
    view.setUint32(8, jsonBytes.byteLength, false);
    view.setUint32(12, geoBytes.byteLength, false);

    bytes.set(jsonBytes, headerSize);
    bytes.set(geoBytes, headerSize + jsonBytes.byteLength);

    return buffer;
  }

  deserialize(data: ArrayBuffer): void {
    const view = new DataView(data);
    const bytes = new Uint8Array(data);

    const magic = view.getUint32(0, false);
    if (magic !== MAGIC) {
      throw new Error('Invalid file format — magic number mismatch.');
    }

    const version = view.getUint32(4, false);
    if (version > VERSION) {
      throw new Error(`Unsupported file version ${version}. Max supported: ${VERSION}.`);
    }

    const jsonLen = view.getUint32(8, false);
    const geoLen = view.getUint32(12, false);
    const headerSize = 16;

    const jsonBytes = bytes.slice(headerSize, headerSize + jsonLen);
    const payload = JSON.parse(decodeString(jsonBytes));

    // Restore metadata
    this.metadata = payload.metadata;

    // Restore geometry
    if (geoLen > 0) {
      const geoBytes = bytes.slice(headerSize + jsonLen, headerSize + jsonLen + geoLen);
      this.geometry.deserialize(geoBytes.buffer);
    }

    // Restore scene
    const sceneManager = new SceneManager();

    // Restore layers
    if (payload.scene.layers) {
      for (const [id, layer] of payload.scene.layers) {
        sceneManager.layers.set(id, layer);
      }
    }

    // Restore component definitions
    if (payload.scene.componentDefinitions) {
      for (const [id, def] of payload.scene.componentDefinitions) {
        sceneManager.componentDefinitions.set(id, def);
      }
    }

    // Restore entities
    if (payload.scene.entities) {
      for (const entity of payload.scene.entities) {
        if (entity.id === payload.scene.rootId) {
          // Overwrite root
          Object.assign(sceneManager.root, entity);
        } else {
          sceneManager.addEntity(entity, entity.parentId ?? undefined);
        }
      }
    }

    // Restore scene pages
    if (payload.scene.scenePages) {
      sceneManager.scenePages.length = 0;
      for (const page of payload.scene.scenePages) {
        sceneManager.scenePages.push(page);
      }
    }

    this.scene = sceneManager;

    // Restore materials
    const matManager = new MaterialManager(this.geometry);
    if (payload.materials) {
      for (const mat of payload.materials) {
        matManager.materials.set(mat.id, mat);
      }
    }
    this.materials = matManager;

    // Rebuild selection and history
    this.selection = new SelectionManager(this.scene, this.geometry);
    this.history = new HistoryManager();

    // Re-wire delta tracking to the new mesh and materials
    (this.history as HistoryManager).setTrackedSources(
      (this.geometry as GeometryEngine).getInternalMesh(),
      this.materials as MaterialManager,
    );

    this.filePath = null;
    this.dirty = false;

    this.wireEvents();
    this.emitter.emit('dirty-changed', false);
    this.emitter.emit('metadata-changed', { ...this.metadata });
  }

  // ── Events ───────────────────────────────────────────────────

  on(event: 'dirty-changed' | 'metadata-changed', handler: (...args: unknown[]) => void): void {
    this.emitter.on(event, handler as never);
  }

  off(event: 'dirty-changed' | 'metadata-changed', handler: (...args: unknown[]) => void): void {
    this.emitter.off(event, handler as never);
  }
}
