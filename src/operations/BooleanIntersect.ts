// @archigraph op.boolean.intersect
// CSG Intersection operation for SketchCraft

import { Vec3 } from '../core/types';
import { IGeometryEngine, IVertex } from '../core/interfaces';
import { vec3, EPSILON } from '../core/math';
import { MeshRegion, BooleanResult } from './BooleanUnion';

export interface BooleanIntersectParams {
  regionA: MeshRegion;
  regionB: MeshRegion;
}

/**
 * CSG Intersect: keeps only the overlapping volume of A and B.
 *
 * Simplified algorithm:
 * 1. Keep faces of A that are inside B.
 * 2. Keep faces of B that are inside A.
 * 3. Stitch boundary edges.
 *
 * Production implementation delegates to Manifold WASM for robustness.
 */
export class BooleanIntersect {
  execute(engine: IGeometryEngine, params: BooleanIntersectParams): BooleanResult {
    const { regionA, regionB } = params;

    const newFaceIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newVertexIds: string[] = [];
    const removedFaceIds: string[] = [];

    // Keep A faces that are inside B
    const aInside = this.classifyFaces(engine, regionA.faceIds, regionB.faceIds, 'inside');

    // Keep B faces that are inside A
    const bInside = this.classifyFaces(engine, regionB.faceIds, regionA.faceIds, 'inside');

    // Remove A faces that are outside B
    for (const faceId of regionA.faceIds) {
      if (aInside.has(faceId)) {
        newFaceIds.push(faceId);
      } else {
        engine.deleteFace(faceId);
        removedFaceIds.push(faceId);
      }
    }

    // Remove B faces that are outside A
    for (const faceId of regionB.faceIds) {
      if (bInside.has(faceId)) {
        newFaceIds.push(faceId);
      } else {
        engine.deleteFace(faceId);
        removedFaceIds.push(faceId);
      }
    }

    // NOTE: Production implementation would invoke Manifold WASM via IPC:
    //   const result = await manifoldIPC.intersect(meshA, meshB);

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
