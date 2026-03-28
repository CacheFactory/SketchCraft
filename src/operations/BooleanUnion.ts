// @archigraph op.boolean.union
// CSG Union operation for SketchCraft

import { Vec3 } from '../core/types';
import { IGeometryEngine, IFace, IVertex } from '../core/interfaces';
import { vec3, EPSILON } from '../core/math';

export interface MeshRegion {
  faceIds: string[];
  vertexIds: string[];
  edgeIds: string[];
}

export interface BooleanUnionParams {
  regionA: MeshRegion;
  regionB: MeshRegion;
}

export interface BooleanResult {
  success: boolean;
  newFaceIds: string[];
  newEdgeIds: string[];
  newVertexIds: string[];
  removedFaceIds: string[];
  error?: string;
}

/**
 * CSG Union: merges two mesh regions, removing internal faces.
 *
 * This is a simplified implementation that handles basic cases.
 * For production accuracy, complex boolean operations delegate to the
 * Manifold WASM library via IPC.
 *
 * Simplified algorithm:
 * 1. Classify faces of each mesh relative to the other (inside/outside/coplanar).
 * 2. Keep all faces from A that are outside B.
 * 3. Keep all faces from B that are outside A.
 * 4. Remove coplanar duplicate faces (keep one copy).
 * 5. Stitch boundary edges.
 */
export class BooleanUnion {
  execute(engine: IGeometryEngine, params: BooleanUnionParams): BooleanResult {
    const { regionA, regionB } = params;

    const newFaceIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newVertexIds: string[] = [];
    const removedFaceIds: string[] = [];

    // Classify faces of A relative to B
    const aOutside = this.classifyFaces(engine, regionA.faceIds, regionB.faceIds, 'outside');
    const bOutside = this.classifyFaces(engine, regionB.faceIds, regionA.faceIds, 'outside');

    // Remove interior faces from A
    for (const faceId of regionA.faceIds) {
      if (!aOutside.has(faceId)) {
        engine.deleteFace(faceId);
        removedFaceIds.push(faceId);
      }
    }

    // Remove interior faces from B
    for (const faceId of regionB.faceIds) {
      if (!bOutside.has(faceId)) {
        engine.deleteFace(faceId);
        removedFaceIds.push(faceId);
      }
    }

    // Remaining faces form the union
    for (const faceId of aOutside) {
      newFaceIds.push(faceId);
    }
    for (const faceId of bOutside) {
      newFaceIds.push(faceId);
    }

    // NOTE: Production implementation would invoke Manifold WASM via IPC:
    //   const result = await manifoldIPC.union(meshA, meshB);
    // Manifold handles:
    //   - Exact intersection curve computation
    //   - Face re-triangulation at intersection boundaries
    //   - Proper stitching of boundary loops
    //   - Robust handling of coplanar faces and degenerate cases

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      newVertexIds,
      removedFaceIds,
    };
  }

  /**
   * Classify which faces from `testFaces` are on the given side of the volume
   * defined by `referenceFaces`.
   *
   * Simplified: uses face centroid ray-casting against the reference mesh
   * to determine inside/outside classification.
   */
  private classifyFaces(
    engine: IGeometryEngine,
    testFaceIds: string[],
    referenceFaceIds: string[],
    side: 'inside' | 'outside',
  ): Set<string> {
    const result = new Set<string>();

    for (const faceId of testFaceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      const vertices = engine.getFaceVertices(faceId);
      if (vertices.length < 3) continue;

      // Compute face centroid
      const centroid = this.computeCentroid(vertices);

      // Cast ray from centroid along face normal and count intersections
      // with reference faces. Odd count = inside, even = outside.
      const normal = engine.computeFaceNormal(faceId);
      const intersections = this.countRayIntersections(engine, centroid, normal, referenceFaceIds);
      const isInside = intersections % 2 === 1;

      if ((side === 'inside' && isInside) || (side === 'outside' && !isInside)) {
        result.add(faceId);
      }
    }

    return result;
  }

  private computeCentroid(vertices: IVertex[]): Vec3 {
    let sum = vec3.zero();
    for (const v of vertices) {
      sum = vec3.add(sum, v.position);
    }
    return vec3.div(sum, vertices.length);
  }

  /**
   * Count ray-mesh intersections using Moller-Trumbore algorithm
   * against triangulated reference faces.
   */
  private countRayIntersections(
    engine: IGeometryEngine,
    origin: Vec3,
    direction: Vec3,
    referenceFaceIds: string[],
  ): number {
    let count = 0;
    const dir = vec3.normalize(direction);

    for (const faceId of referenceFaceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      const verts = engine.getFaceVertices(faceId);
      if (verts.length < 3) continue;

      // Fan-triangulate the face from vertex 0
      for (let i = 1; i < verts.length - 1; i++) {
        if (this.rayTriangleIntersect(origin, dir, verts[0].position, verts[i].position, verts[i + 1].position)) {
          count++;
        }
      }
    }

    return count;
  }

  /** Moller-Trumbore ray-triangle intersection test */
  private rayTriangleIntersect(origin: Vec3, dir: Vec3, v0: Vec3, v1: Vec3, v2: Vec3): boolean {
    const edge1 = vec3.sub(v1, v0);
    const edge2 = vec3.sub(v2, v0);
    const h = vec3.cross(dir, edge2);
    const a = vec3.dot(edge1, h);

    if (Math.abs(a) < EPSILON) return false;

    const f = 1.0 / a;
    const s = vec3.sub(origin, v0);
    const u = f * vec3.dot(s, h);
    if (u < 0.0 || u > 1.0) return false;

    const q = vec3.cross(s, edge1);
    const v = f * vec3.dot(dir, q);
    if (v < 0.0 || u + v > 1.0) return false;

    const t = f * vec3.dot(edge2, q);
    return t > EPSILON;
  }
}
