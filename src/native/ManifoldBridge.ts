// @archigraph native.manifold-bridge
// Bridge to Manifold WASM for CSG boolean operations
// Manifold: https://github.com/elalish/manifold

import { Vec3 } from '../core/types';

// ─── Types ──────────────────────────────────────────────────────

export interface ManifoldMesh {
  vertices: Vec3[];
  faces: number[][]; // each face is an array of vertex indices (triangulated)
}

export interface ManifoldModule {
  Manifold: {
    new(mesh: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }): ManifoldInstance;
  };
  setup(): Promise<void>;
}

export interface ManifoldInstance {
  add(other: ManifoldInstance): ManifoldInstance;
  subtract(other: ManifoldInstance): ManifoldInstance;
  intersect(other: ManifoldInstance): ManifoldInstance;
  getMesh(): { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
  delete(): void;
}

// ─── Bridge ─────────────────────────────────────────────────────

export class ManifoldBridge {
  private module: ManifoldModule | null = null;
  private initialized = false;

  /**
   * Initialize the Manifold WASM module.
   * Must be called before any boolean operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamic import of the manifold-wasm package
      // This will be resolved at runtime if the package is installed.
      // @ts-ignore - Optional dependency, loaded at runtime if available
      const manifoldModule = await import('manifold-3d');
      this.module = manifoldModule as unknown as ManifoldModule;
      await this.module.setup();
      this.initialized = true;
    } catch {
      throw new Error(
        'Failed to load Manifold WASM module. ' +
        'Install the "manifold-3d" package: npm install manifold-3d',
      );
    }
  }

  /**
   * Check if the Manifold module is ready.
   */
  isReady(): boolean {
    return this.initialized && this.module !== null;
  }

  /**
   * Convert a ManifoldMesh to the internal Manifold representation.
   */
  private toManifold(mesh: ManifoldMesh): ManifoldInstance {
    if (!this.module) throw new Error('Manifold not initialized');

    // Flatten vertices into a Float32Array (3 properties per vertex: x, y, z)
    const vertProperties = new Float32Array(mesh.vertices.length * 3);
    for (let i = 0; i < mesh.vertices.length; i++) {
      vertProperties[i * 3] = mesh.vertices[i].x;
      vertProperties[i * 3 + 1] = mesh.vertices[i].y;
      vertProperties[i * 3 + 2] = mesh.vertices[i].z;
    }

    // Flatten triangle indices
    const triVerts = new Uint32Array(mesh.faces.length * 3);
    for (let i = 0; i < mesh.faces.length; i++) {
      triVerts[i * 3] = mesh.faces[i][0];
      triVerts[i * 3 + 1] = mesh.faces[i][1];
      triVerts[i * 3 + 2] = mesh.faces[i][2];
    }

    return new this.module.Manifold({ numProp: 3, vertProperties, triVerts });
  }

  /**
   * Convert a Manifold instance back to our mesh format.
   */
  private fromManifold(instance: ManifoldInstance): ManifoldMesh {
    const result = instance.getMesh();
    const vertices: Vec3[] = [];
    const faces: number[][] = [];

    const numVerts = result.vertProperties.length / result.numProp;
    for (let i = 0; i < numVerts; i++) {
      vertices.push({
        x: result.vertProperties[i * result.numProp],
        y: result.vertProperties[i * result.numProp + 1],
        z: result.vertProperties[i * result.numProp + 2],
      });
    }

    const numTris = result.triVerts.length / 3;
    for (let i = 0; i < numTris; i++) {
      faces.push([
        result.triVerts[i * 3],
        result.triVerts[i * 3 + 1],
        result.triVerts[i * 3 + 2],
      ]);
    }

    return { vertices, faces };
  }

  /**
   * Compute the union of two meshes.
   * The result contains geometry from both meshes.
   */
  async union(meshA: ManifoldMesh, meshB: ManifoldMesh): Promise<ManifoldMesh> {
    if (!this.initialized) await this.initialize();

    const a = this.toManifold(meshA);
    const b = this.toManifold(meshB);

    try {
      const result = a.add(b);
      const mesh = this.fromManifold(result);
      result.delete();
      return mesh;
    } finally {
      a.delete();
      b.delete();
    }
  }

  /**
   * Subtract meshB from meshA.
   * The result contains geometry of A with B's volume removed.
   */
  async subtract(meshA: ManifoldMesh, meshB: ManifoldMesh): Promise<ManifoldMesh> {
    if (!this.initialized) await this.initialize();

    const a = this.toManifold(meshA);
    const b = this.toManifold(meshB);

    try {
      const result = a.subtract(b);
      const mesh = this.fromManifold(result);
      result.delete();
      return mesh;
    } finally {
      a.delete();
      b.delete();
    }
  }

  /**
   * Compute the intersection of two meshes.
   * The result contains only the overlapping volume.
   */
  async intersect(meshA: ManifoldMesh, meshB: ManifoldMesh): Promise<ManifoldMesh> {
    if (!this.initialized) await this.initialize();

    const a = this.toManifold(meshA);
    const b = this.toManifold(meshB);

    try {
      const result = a.intersect(b);
      const mesh = this.fromManifold(result);
      result.delete();
      return mesh;
    } finally {
      a.delete();
      b.delete();
    }
  }

  /**
   * Release WASM resources.
   */
  dispose(): void {
    this.module = null;
    this.initialized = false;
  }
}
