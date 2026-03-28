// @archigraph op.sweep
// Follow-me / sweep operation for SketchCraft

import { Vec3 } from '../core/types';
import { IGeometryEngine, IFace, IVertex } from '../core/interfaces';
import { vec3, EPSILON } from '../core/math';

export interface SweepParams {
  profileFaceId: string;  // the face to sweep (profile)
  pathEdgeIds: string[];  // ordered edge IDs forming the sweep path
  alignToPath?: boolean;  // rotate profile to follow path curvature (default: true)
}

export interface SweepResult {
  success: boolean;
  newFaceIds: string[];
  newEdgeIds: string[];
  newVertexIds: string[];
  error?: string;
}

/**
 * Sweep Operation (Follow-Me): sweeps a profile face along a path of edges.
 *
 * Algorithm:
 * 1. Extract the ordered path vertices from the path edges.
 * 2. At each path vertex, compute a local coordinate frame (Frenet or fixed).
 * 3. Transform the profile vertices into each frame to get cross-section rings.
 * 4. Connect consecutive rings with quad faces.
 * 5. Optionally cap the start and end.
 */
export class SweepOperation {
  execute(engine: IGeometryEngine, params: SweepParams): SweepResult {
    const { profileFaceId, pathEdgeIds, alignToPath = true } = params;

    const profileFace = engine.getFace(profileFaceId);
    if (!profileFace) {
      return { success: false, newFaceIds: [], newEdgeIds: [], newVertexIds: [], error: `Profile face ${profileFaceId} not found` };
    }

    if (pathEdgeIds.length === 0) {
      return { success: false, newFaceIds: [], newEdgeIds: [], newVertexIds: [], error: 'Path must have at least one edge' };
    }

    // Extract ordered path points
    const pathPoints = this.extractPathPoints(engine, pathEdgeIds);
    if (!pathPoints) {
      return { success: false, newFaceIds: [], newEdgeIds: [], newVertexIds: [], error: 'Path edges are not connected' };
    }

    if (pathPoints.length < 2) {
      return { success: false, newFaceIds: [], newEdgeIds: [], newVertexIds: [], error: 'Path must have at least 2 points' };
    }

    // Get profile vertices relative to profile centroid
    const profileVertices = engine.getFaceVertices(profileFaceId);
    const profileNormal = engine.computeFaceNormal(profileFaceId);
    const centroid = this.computeCentroid(profileVertices);

    // Relative profile positions (in profile-local space)
    const profileLocal = profileVertices.map(v => vec3.sub(v.position, centroid));

    const newVertexIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newFaceIds: string[] = [];

    // Generate cross-section rings at each path point
    const rings: string[][] = [];

    for (let pi = 0; pi < pathPoints.length; pi++) {
      const pathPoint = pathPoints[pi];

      // Compute local frame at this path point
      let tangent: Vec3;
      if (pi === 0) {
        tangent = vec3.normalize(vec3.sub(pathPoints[1], pathPoints[0]));
      } else if (pi === pathPoints.length - 1) {
        tangent = vec3.normalize(vec3.sub(pathPoints[pi], pathPoints[pi - 1]));
      } else {
        // Average of incoming and outgoing tangent
        const t0 = vec3.normalize(vec3.sub(pathPoints[pi], pathPoints[pi - 1]));
        const t1 = vec3.normalize(vec3.sub(pathPoints[pi + 1], pathPoints[pi]));
        tangent = vec3.normalize(vec3.add(t0, t1));
      }

      const ring: string[] = [];

      if (alignToPath) {
        // Build rotation from profile normal to path tangent
        const { right, up } = this.buildFrame(tangent, profileNormal);

        for (const local of profileLocal) {
          // Transform profile point: centroid offset projected onto new frame
          const worldPos = vec3.add(
            pathPoint,
            vec3.add(
              vec3.mul(right, local.x * vec3.length(vec3.create(local.x, local.y, local.z)) > EPSILON ? 1 : 0),
              vec3.add(
                vec3.mul(right, vec3.dot(local, this.getRight(profileNormal))),
                vec3.mul(up, vec3.dot(local, this.getUp(profileNormal))),
              ),
            ),
          );
          const v = engine.createVertex(worldPos);
          ring.push(v.id);
          newVertexIds.push(v.id);
        }
      } else {
        // Fixed orientation: just translate the profile
        for (const local of profileLocal) {
          const worldPos = vec3.add(pathPoint, local);
          const v = engine.createVertex(worldPos);
          ring.push(v.id);
          newVertexIds.push(v.id);
        }
      }

      rings.push(ring);
    }

    // Connect consecutive rings with quad faces
    const profileCount = profileLocal.length;
    for (let ri = 0; ri < rings.length - 1; ri++) {
      const ringA = rings[ri];
      const ringB = rings[ri + 1];

      for (let vi = 0; vi < profileCount; vi++) {
        const vj = (vi + 1) % profileCount;

        const face = engine.createFace([
          ringA[vi], ringB[vi], ringB[vj], ringA[vj],
        ]);
        newFaceIds.push(face.id);
      }
    }

    // Create edges along and between rings
    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      // Ring edges
      for (let vi = 0; vi < profileCount; vi++) {
        const vj = (vi + 1) % profileCount;
        const e = engine.createEdge(ring[vi], ring[vj]);
        newEdgeIds.push(e.id);
      }
      // Longitudinal edges connecting to next ring
      if (ri < rings.length - 1) {
        const nextRing = rings[ri + 1];
        for (let vi = 0; vi < profileCount; vi++) {
          const e = engine.createEdge(ring[vi], nextRing[vi]);
          newEdgeIds.push(e.id);
        }
      }
    }

    // Cap start and end with faces
    if (rings.length > 0) {
      const startCap = engine.createFace([...rings[0]].reverse());
      const endCap = engine.createFace(rings[rings.length - 1]);
      newFaceIds.push(startCap.id, endCap.id);
    }

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      newVertexIds,
    };
  }

  /** Extract ordered path points from connected edge IDs */
  private extractPathPoints(engine: IGeometryEngine, edgeIds: string[]): Vec3[] | null {
    if (edgeIds.length === 0) return null;

    const points: Vec3[] = [];

    // Start with the first edge
    const firstEdge = engine.getEdge(edgeIds[0]);
    if (!firstEdge) return null;

    let currentEndId: string;

    if (edgeIds.length === 1) {
      const sv = engine.getVertex(firstEdge.startVertexId)!;
      const ev = engine.getVertex(firstEdge.endVertexId)!;
      return [sv.position, ev.position];
    }

    // Determine orientation of first edge by checking which vertex connects to second edge
    const secondEdge = engine.getEdge(edgeIds[1]);
    if (!secondEdge) return null;

    if (firstEdge.endVertexId === secondEdge.startVertexId || firstEdge.endVertexId === secondEdge.endVertexId) {
      points.push(engine.getVertex(firstEdge.startVertexId)!.position);
      points.push(engine.getVertex(firstEdge.endVertexId)!.position);
      currentEndId = firstEdge.endVertexId;
    } else if (firstEdge.startVertexId === secondEdge.startVertexId || firstEdge.startVertexId === secondEdge.endVertexId) {
      points.push(engine.getVertex(firstEdge.endVertexId)!.position);
      points.push(engine.getVertex(firstEdge.startVertexId)!.position);
      currentEndId = firstEdge.startVertexId;
    } else {
      return null; // Edges not connected
    }

    // Follow remaining edges
    for (let i = 1; i < edgeIds.length; i++) {
      const edge = engine.getEdge(edgeIds[i]);
      if (!edge) return null;

      if (edge.startVertexId === currentEndId) {
        currentEndId = edge.endVertexId;
      } else if (edge.endVertexId === currentEndId) {
        currentEndId = edge.startVertexId;
      } else {
        return null; // Discontinuous path
      }

      points.push(engine.getVertex(currentEndId)!.position);
    }

    return points;
  }

  private computeCentroid(vertices: IVertex[]): Vec3 {
    let sum = vec3.zero();
    for (const v of vertices) {
      sum = vec3.add(sum, v.position);
    }
    return vec3.div(sum, vertices.length);
  }

  /** Build a local coordinate frame from a tangent direction */
  private buildFrame(tangent: Vec3, referenceNormal: Vec3): { right: Vec3; up: Vec3 } {
    let up = vec3.cross(tangent, referenceNormal);
    if (vec3.length(up) < EPSILON) {
      // Tangent is parallel to reference normal, pick arbitrary perpendicular
      up = vec3.cross(tangent, vec3.right());
      if (vec3.length(up) < EPSILON) {
        up = vec3.cross(tangent, vec3.up());
      }
    }
    up = vec3.normalize(up);
    const right = vec3.normalize(vec3.cross(up, tangent));
    return { right, up };
  }

  private getRight(normal: Vec3): Vec3 {
    let right = vec3.cross(normal, vec3.up());
    if (vec3.length(right) < EPSILON) {
      right = vec3.cross(normal, vec3.forward());
    }
    return vec3.normalize(right);
  }

  private getUp(normal: Vec3): Vec3 {
    const right = this.getRight(normal);
    return vec3.normalize(vec3.cross(right, normal));
  }
}
