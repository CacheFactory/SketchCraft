// @archigraph op.intersect-faces
// Face intersection operation for SketchCraft

import { Vec3, Plane } from '../../src/core/types';
import { IGeometryEngine, IFace, IVertex, IEdge } from '../../src/core/interfaces';
import { vec3, EPSILON } from '../../src/core/math';

export interface IntersectFacesParams {
  faceIdA: string;
  faceIdB: string;
}

export interface IntersectFacesResult {
  success: boolean;
  intersectionEdgeIds: string[];      // new edges at the intersection
  intersectionVertexIds: string[];    // new vertices at intersection points
  splitFaceIds: string[];             // new faces from splitting originals
  removedFaceIds: string[];           // original faces that were split
  hasIntersection: boolean;
  error?: string;
}

/**
 * Intersect Faces Operation: finds the intersection line between two
 * overlapping faces and splits both faces along that line.
 *
 * Algorithm:
 * 1. Compute the intersection line of the two face planes.
 * 2. Clip the intersection line to each face's polygon boundary.
 * 3. The overlap of those two clipped segments is the actual intersection.
 * 4. Create vertices at the intersection endpoints.
 * 5. Split each face along the intersection edge.
 */
export class IntersectFacesOperation {
  execute(engine: IGeometryEngine, params: IntersectFacesParams): IntersectFacesResult {
    const { faceIdA, faceIdB } = params;

    const faceA = engine.getFace(faceIdA);
    const faceB = engine.getFace(faceIdB);

    if (!faceA || !faceB) {
      return {
        success: false, intersectionEdgeIds: [], intersectionVertexIds: [],
        splitFaceIds: [], removedFaceIds: [], hasIntersection: false,
        error: 'One or both faces not found',
      };
    }

    const normalA = engine.computeFaceNormal(faceIdA);
    const normalB = engine.computeFaceNormal(faceIdB);

    // Compute intersection line direction: cross product of normals
    const lineDir = vec3.cross(normalA, normalB);
    if (vec3.length(lineDir) < EPSILON) {
      // Planes are parallel (or coincident) -- no intersection line
      return {
        success: true, intersectionEdgeIds: [], intersectionVertexIds: [],
        splitFaceIds: [], removedFaceIds: [], hasIntersection: false,
      };
    }

    const lineDirNorm = vec3.normalize(lineDir);

    // Find a point on the intersection line by solving the two plane equations
    const lineOrigin = this.findPointOnIntersectionLine(faceA.plane, faceB.plane, lineDirNorm);
    if (!lineOrigin) {
      return {
        success: true, intersectionEdgeIds: [], intersectionVertexIds: [],
        splitFaceIds: [], removedFaceIds: [], hasIntersection: false,
      };
    }

    // Clip the infinite intersection line to each face polygon
    const vertsA = engine.getFaceVertices(faceIdA).map(v => v.position);
    const vertsB = engine.getFaceVertices(faceIdB).map(v => v.position);

    const segA = this.clipLineToPolygon(lineOrigin, lineDirNorm, vertsA, normalA);
    const segB = this.clipLineToPolygon(lineOrigin, lineDirNorm, vertsB, normalB);

    if (!segA || !segB) {
      return {
        success: true, intersectionEdgeIds: [], intersectionVertexIds: [],
        splitFaceIds: [], removedFaceIds: [], hasIntersection: false,
      };
    }

    // Find overlap of the two 1D segments (parameterized along lineDir)
    const overlap = this.segmentOverlap(segA[0], segA[1], segB[0], segB[1]);
    if (!overlap) {
      return {
        success: true, intersectionEdgeIds: [], intersectionVertexIds: [],
        splitFaceIds: [], removedFaceIds: [], hasIntersection: false,
      };
    }

    // Create intersection vertices at the overlap endpoints
    const p0 = vec3.add(lineOrigin, vec3.mul(lineDirNorm, overlap[0]));
    const p1 = vec3.add(lineOrigin, vec3.mul(lineDirNorm, overlap[1]));

    if (vec3.distance(p0, p1) < EPSILON) {
      // Degenerate: single point intersection
      return {
        success: true, intersectionEdgeIds: [], intersectionVertexIds: [],
        splitFaceIds: [], removedFaceIds: [], hasIntersection: false,
      };
    }

    const v0 = engine.createVertex(p0);
    const v1 = engine.createVertex(p1);
    const intersectionVertexIds = [v0.id, v1.id];

    // Create the intersection edge
    const intEdge = engine.createEdge(v0.id, v1.id);
    const intersectionEdgeIds = [intEdge.id];

    // Split both faces along the intersection edge
    const splitFaceIds: string[] = [];
    const removedFaceIds: string[] = [];

    const splitA = this.splitFaceAlongEdge(engine, faceIdA, v0.id, v1.id);
    if (splitA) {
      splitFaceIds.push(...splitA.newFaceIds);
      removedFaceIds.push(faceIdA);
    }

    const splitB = this.splitFaceAlongEdge(engine, faceIdB, v0.id, v1.id);
    if (splitB) {
      splitFaceIds.push(...splitB.newFaceIds);
      removedFaceIds.push(faceIdB);
    }

    return {
      success: true,
      intersectionEdgeIds,
      intersectionVertexIds,
      splitFaceIds,
      removedFaceIds,
      hasIntersection: true,
    };
  }

  /**
   * Find a point on the intersection of two planes.
   * Solves the system using the direction perpendicular to both normals.
   */
  private findPointOnIntersectionLine(
    planeA: Plane,
    planeB: Plane,
    lineDir: Vec3,
  ): Vec3 | null {
    // Use the method: point = (d1*(n2 x lineDir) + d2*(lineDir x n1)) / (lineDir . lineDir)
    const n1 = planeA.normal;
    const n2 = planeB.normal;
    const d1 = planeA.distance;
    const d2 = planeB.distance;

    const n2CrossDir = vec3.cross(n2, lineDir);
    const dirCrossN1 = vec3.cross(lineDir, n1);
    const denom = vec3.dot(lineDir, lineDir);

    if (Math.abs(denom) < EPSILON) return null;

    const p = vec3.div(
      vec3.add(vec3.mul(n2CrossDir, d1), vec3.mul(dirCrossN1, d2)),
      denom,
    );

    return p;
  }

  /**
   * Clip an infinite line to a convex polygon, returning the parameter range [tMin, tMax].
   * The line is parameterized as: P = origin + t * direction.
   */
  private clipLineToPolygon(
    origin: Vec3,
    direction: Vec3,
    polygonVerts: Vec3[],
    polygonNormal: Vec3,
  ): [number, number] | null {
    let tMin = -Infinity;
    let tMax = Infinity;

    const n = polygonVerts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const edgeDir = vec3.sub(polygonVerts[j], polygonVerts[i]);
      // Inward-facing edge normal in the polygon plane
      const edgeNormal = vec3.normalize(vec3.cross(polygonNormal, edgeDir));

      const denom = vec3.dot(direction, edgeNormal);
      const dist = vec3.dot(vec3.sub(polygonVerts[i], origin), edgeNormal);

      if (Math.abs(denom) < EPSILON) {
        // Line is parallel to this edge
        if (dist < -EPSILON) return null; // Outside
        continue;
      }

      const t = dist / denom;
      if (denom < 0) {
        tMin = Math.max(tMin, t);
      } else {
        tMax = Math.min(tMax, t);
      }

      if (tMin > tMax + EPSILON) return null;
    }

    if (tMin > tMax + EPSILON) return null;
    return [tMin, tMax];
  }

  /** Find the overlap of two 1D segments [a0,a1] and [b0,b1] */
  private segmentOverlap(
    a0: number, a1: number,
    b0: number, b1: number,
  ): [number, number] | null {
    const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
    const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
    if (lo >= hi - EPSILON) return null;
    return [lo, hi];
  }

  /**
   * Split a face along an edge defined by two vertex IDs that lie on the face boundary.
   * Creates two new faces from the split.
   */
  private splitFaceAlongEdge(
    engine: IGeometryEngine,
    faceId: string,
    splitV0Id: string,
    splitV1Id: string,
  ): { newFaceIds: string[] } | null {
    const face = engine.getFace(faceId);
    if (!face) return null;

    const vertexIds = [...face.vertexIds];
    const n = vertexIds.length;

    // Find which edges the split vertices lie on (or nearest vertices)
    // Insert split vertices into the polygon at the correct positions
    const insertions = this.findInsertionPoints(engine, vertexIds, splitV0Id, splitV1Id);
    if (!insertions) return null;

    const { polygon, idx0, idx1 } = insertions;

    // Split polygon into two parts at idx0 and idx1
    const polyA: string[] = [];
    const polyB: string[] = [];

    // Walk from idx0 to idx1
    let i = idx0;
    while (true) {
      polyA.push(polygon[i]);
      if (i === idx1) break;
      i = (i + 1) % polygon.length;
    }

    // Walk from idx1 to idx0
    i = idx1;
    while (true) {
      polyB.push(polygon[i]);
      if (i === idx0) break;
      i = (i + 1) % polygon.length;
    }

    if (polyA.length < 3 || polyB.length < 3) return null;

    // Delete original face and create two new ones
    engine.deleteFace(faceId);

    const faceA = engine.createFace(polyA);
    const faceB = engine.createFace(polyB);

    return { newFaceIds: [faceA.id, faceB.id] };
  }

  /**
   * Find where to insert the split vertices into the polygon vertex list.
   * Returns the modified polygon and indices of the two split vertices.
   */
  private findInsertionPoints(
    engine: IGeometryEngine,
    vertexIds: string[],
    splitV0Id: string,
    splitV1Id: string,
  ): { polygon: string[]; idx0: number; idx1: number } | null {
    const polygon = [...vertexIds];
    let idx0 = -1;
    let idx1 = -1;

    // Check if split vertices already exist in the polygon
    for (let i = 0; i < polygon.length; i++) {
      if (polygon[i] === splitV0Id) idx0 = i;
      if (polygon[i] === splitV1Id) idx1 = i;
    }

    // If not found, insert on the nearest edge
    if (idx0 === -1) {
      const insertIdx = this.findNearestEdgeInsert(engine, polygon, splitV0Id);
      if (insertIdx === -1) return null;
      polygon.splice(insertIdx + 1, 0, splitV0Id);
      idx0 = insertIdx + 1;
    }

    if (idx1 === -1) {
      const insertIdx = this.findNearestEdgeInsert(engine, polygon, splitV1Id);
      if (insertIdx === -1) return null;
      // Adjust for possible shift from previous insertion
      const adjustedIdx = insertIdx >= idx0 ? insertIdx : insertIdx;
      polygon.splice(adjustedIdx + 1, 0, splitV1Id);
      idx1 = adjustedIdx + 1;
      // Recompute idx0 if it shifted
      if (adjustedIdx + 1 <= idx0) idx0++;
    }

    if (idx0 === -1 || idx1 === -1 || idx0 === idx1) return null;

    return { polygon, idx0, idx1 };
  }

  /**
   * Find which polygon edge the vertex is closest to, for insertion.
   */
  private findNearestEdgeInsert(
    engine: IGeometryEngine,
    polygon: string[],
    vertexId: string,
  ): number {
    const v = engine.getVertex(vertexId);
    if (!v) return -1;

    let bestDist = Infinity;
    let bestIdx = -1;

    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      const va = engine.getVertex(polygon[i]);
      const vb = engine.getVertex(polygon[j]);
      if (!va || !vb) continue;

      const projected = vec3.projectOnLine(v.position, va.position, vb.position);
      const dist = vec3.distance(v.position, projected);

      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    return bestIdx;
  }
}
