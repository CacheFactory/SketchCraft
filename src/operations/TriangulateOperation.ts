// @archigraph op.triangulate
// Face triangulation using ear-clipping for SketchCraft

import { Vec3, Vec2 } from '../core/types';
import { IGeometryEngine, IFace, IVertex } from '../core/interfaces';
import { vec3, EPSILON } from '../core/math';

export interface TriangulateParams {
  faceIds: string[];  // faces to triangulate (empty = all non-triangle faces)
}

export interface TriangulateResult {
  success: boolean;
  newFaceIds: string[];
  newEdgeIds: string[];
  removedFaceIds: string[];
  triangleCount: number;
  error?: string;
}

/**
 * Triangulate Operation: converts n-gon faces into triangles using ear-clipping.
 *
 * Used for rendering (GPUs expect triangles) and export formats that require
 * triangulated meshes.
 *
 * Algorithm (ear-clipping):
 * 1. Project the polygon onto its dominant 2D plane.
 * 2. Find "ear" vertices (triangle formed with neighbors is entirely inside polygon).
 * 3. Clip the ear (create triangle, remove vertex from polygon).
 * 4. Repeat until only a triangle remains.
 */
export class TriangulateOperation {
  execute(engine: IGeometryEngine, params: TriangulateParams): TriangulateResult {
    let faceIds = params.faceIds;

    if (faceIds.length === 0) {
      // Triangulate all non-triangle faces
      const mesh = engine.getMesh();
      faceIds = [];
      for (const [id, face] of mesh.faces) {
        if (face.vertexIds.length > 3) {
          faceIds.push(id);
        }
      }
    }

    const newFaceIds: string[] = [];
    const newEdgeIds: string[] = [];
    const removedFaceIds: string[] = [];
    let triangleCount = 0;

    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      const vertexIds = face.vertexIds;
      const n = vertexIds.length;

      if (n < 3) continue;
      if (n === 3) {
        // Already a triangle, skip
        continue;
      }

      const normal = engine.computeFaceNormal(faceId);
      const vertices = engine.getFaceVertices(faceId);
      const positions = vertices.map(v => v.position);

      // Project to 2D for ear-clipping
      const projected = this.projectTo2D(positions, normal);
      const materialIndex = face.materialIndex;

      // Run ear-clipping
      const triangles = this.earClip(projected, vertexIds);

      if (triangles.length === 0) {
        // Fallback: fan triangulation from vertex 0
        for (let i = 1; i < n - 1; i++) {
          const triFace = engine.createFace([vertexIds[0], vertexIds[i], vertexIds[i + 1]]);
          newFaceIds.push(triFace.id);
          triangleCount++;

          // Create diagonal edge if it does not already exist
          if (i > 1) {
            const existing = engine.findEdgeBetween(vertexIds[0], vertexIds[i]);
            if (!existing) {
              const e = engine.createEdge(vertexIds[0], vertexIds[i]);
              newEdgeIds.push(e.id);
            }
          }
        }
      } else {
        for (const tri of triangles) {
          const triFace = engine.createFace(tri);
          newFaceIds.push(triFace.id);
          triangleCount++;

          // Create internal diagonal edges
          for (let i = 0; i < 3; i++) {
            const j = (i + 1) % 3;
            const existing = engine.findEdgeBetween(tri[i], tri[j]);
            if (!existing) {
              const e = engine.createEdge(tri[i], tri[j]);
              newEdgeIds.push(e.id);
            }
          }
        }
      }

      // Remove the original n-gon face
      engine.deleteFace(faceId);
      removedFaceIds.push(faceId);
    }

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      removedFaceIds,
      triangleCount,
    };
  }

  /**
   * Project 3D polygon vertices onto a 2D plane using the face normal
   * to determine the dominant projection axis.
   */
  private projectTo2D(positions: Vec3[], normal: Vec3): Vec2[] {
    // Choose the projection plane by dropping the axis with the largest normal component
    const absX = Math.abs(normal.x);
    const absY = Math.abs(normal.y);
    const absZ = Math.abs(normal.z);

    if (absZ >= absX && absZ >= absY) {
      // Project onto XY
      return positions.map(p => ({ x: p.x, y: p.y }));
    } else if (absY >= absX && absY >= absZ) {
      // Project onto XZ
      return positions.map(p => ({ x: p.x, y: p.z }));
    } else {
      // Project onto YZ
      return positions.map(p => ({ x: p.y, y: p.z }));
    }
  }

  /**
   * Ear-clipping triangulation algorithm.
   *
   * Returns an array of triangles, each as [vertexId0, vertexId1, vertexId2].
   */
  private earClip(projected: Vec2[], vertexIds: string[]): string[][] {
    const n = projected.length;
    if (n < 3) return [];
    if (n === 3) return [[vertexIds[0], vertexIds[1], vertexIds[2]]];

    const triangles: string[][] = [];

    // Create a linked list of vertex indices
    const indices = Array.from({ length: n }, (_, i) => i);

    // Ensure the polygon is counter-clockwise
    if (this.signedArea2D(projected, indices) < 0) {
      indices.reverse();
    }

    let remaining = [...indices];
    let maxIterations = remaining.length * remaining.length; // Safety limit

    while (remaining.length > 3 && maxIterations > 0) {
      maxIterations--;
      let earFound = false;

      for (let i = 0; i < remaining.length; i++) {
        const prevIdx = (i - 1 + remaining.length) % remaining.length;
        const nextIdx = (i + 1) % remaining.length;

        const a = remaining[prevIdx];
        const b = remaining[i];
        const c = remaining[nextIdx];

        // Check if this vertex forms a convex angle
        if (!this.isConvex(projected[a], projected[b], projected[c])) {
          continue;
        }

        // Check that no other vertex lies inside the ear triangle
        let isEar = true;
        for (let j = 0; j < remaining.length; j++) {
          if (j === prevIdx || j === i || j === nextIdx) continue;
          if (this.pointInTriangle(projected[remaining[j]], projected[a], projected[b], projected[c])) {
            isEar = false;
            break;
          }
        }

        if (isEar) {
          triangles.push([vertexIds[a], vertexIds[b], vertexIds[c]]);
          remaining.splice(i, 1);
          earFound = true;
          break;
        }
      }

      if (!earFound) {
        // No ear found (degenerate polygon). Fall back to remaining as-is.
        break;
      }
    }

    // Add the final triangle
    if (remaining.length === 3) {
      triangles.push([
        vertexIds[remaining[0]],
        vertexIds[remaining[1]],
        vertexIds[remaining[2]],
      ]);
    }

    return triangles;
  }

  /** Signed area of a 2D polygon (positive = CCW) */
  private signedArea2D(points: Vec2[], indices: number[]): number {
    let area = 0;
    const n = indices.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const pi = points[indices[i]];
      const pj = points[indices[j]];
      area += (pi.x * pj.y) - (pj.x * pi.y);
    }
    return area * 0.5;
  }

  /** Check if angle at B is convex (CCW winding) */
  private isConvex(a: Vec2, b: Vec2, c: Vec2): boolean {
    return this.cross2D(a, b, c) > 0;
  }

  /** 2D cross product of vectors BA and BC */
  private cross2D(a: Vec2, b: Vec2, c: Vec2): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  /** Check if point P is inside triangle ABC using barycentric coordinates */
  private pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
    const d1 = this.cross2D(a, b, p);
    const d2 = this.cross2D(b, c, p);
    const d3 = this.cross2D(c, a, p);

    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

    return !(hasNeg && hasPos);
  }
}
