// @archigraph op.boolean.subtract
// CSG Subtraction operation for SketchCraft

import { Vec3 } from '../../src/core/types';
import { IGeometryEngine, IVertex } from '../../src/core/interfaces';
import { vec3, EPSILON } from '../../src/core/math';
import { MeshRegion, BooleanResult } from '../op.boolean_union/BooleanUnion';

export interface BooleanSubtractParams {
  /** The mesh to subtract from */
  regionA: MeshRegion;
  /** The mesh to subtract */
  regionB: MeshRegion;
}

/**
 * CSG Subtract: removes the volume of B from A.
 *
 * Simplified algorithm:
 * 1. Classify faces of A relative to B (keep outside faces of A).
 * 2. Classify faces of B relative to A (keep inside faces of B, reversed).
 * 3. Flip normals of B's inside faces (they become interior walls).
 * 4. Stitch boundary edges.
 *
 * Production implementation delegates to Manifold WASM for robustness.
 */
export class BooleanSubtract {
  execute(engine: IGeometryEngine, params: BooleanSubtractParams): BooleanResult {
    const { regionA, regionB } = params;

    const newFaceIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newVertexIds: string[] = [];
    const removedFaceIds: string[] = [];

    // Classify A faces: keep those outside B
    const aOutside = this.classifyFaces(engine, regionA.faceIds, regionB.faceIds, 'outside');

    // Classify B faces: keep those inside A (they become the "carved" interior)
    const bInside = this.classifyFaces(engine, regionB.faceIds, regionA.faceIds, 'inside');

    // Remove A faces that are inside B (subtracted away)
    for (const faceId of regionA.faceIds) {
      if (!aOutside.has(faceId)) {
        engine.deleteFace(faceId);
        removedFaceIds.push(faceId);
      } else {
        newFaceIds.push(faceId);
      }
    }

    // Reverse winding of B's interior faces and keep them.
    // These form the interior walls of the subtraction cavity.
    for (const faceId of regionB.faceIds) {
      if (bInside.has(faceId)) {
        // Reverse the face by recreating it with reversed vertex order
        const face = engine.getFace(faceId);
        if (face) {
          const reversedVerts = [...face.vertexIds].reverse();
          engine.deleteFace(faceId);
          const newFace = engine.createFace(reversedVerts);
          newFaceIds.push(newFace.id);
        }
      } else {
        engine.deleteFace(faceId);
        removedFaceIds.push(faceId);
      }
    }

    // NOTE: Production implementation would invoke Manifold WASM via IPC:
    //   const result = await manifoldIPC.subtract(meshA, meshB);
    // Manifold handles exact intersection, re-triangulation, and stitching.

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      newVertexIds,
      removedFaceIds,
    };
  }

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

      const centroid = this.computeCentroid(vertices);
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

  private countRayIntersections(
    engine: IGeometryEngine,
    origin: Vec3,
    direction: Vec3,
    referenceFaceIds: string[],
  ): number {
    let count = 0;
    const dir = vec3.normalize(direction);

    for (const faceId of referenceFaceIds) {
      const verts = engine.getFaceVertices(faceId);
      if (verts.length < 3) continue;

      for (let i = 1; i < verts.length - 1; i++) {
        if (this.rayTriangleIntersect(origin, dir, verts[0].position, verts[i].position, verts[i + 1].position)) {
          count++;
        }
      }
    }

    return count;
  }

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
