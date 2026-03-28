// @archigraph op.chamfer
// Edge chamfering operation for SketchCraft

import { Vec3 } from '../core/types';
import { IGeometryEngine, IEdge } from '../core/interfaces';
import { vec3, EPSILON } from '../core/math';

export interface ChamferParams {
  edgeId: string;
  distance: number;          // equal distance on both faces
  distanceA?: number;        // optional asymmetric: distance on face A
  distanceB?: number;        // optional asymmetric: distance on face B
}

export interface ChamferResult {
  success: boolean;
  chamferFaceId: string | null;
  newEdgeIds: string[];
  newVertexIds: string[];
  removedEdgeId: string | null;
  error?: string;
}

/**
 * Chamfer Operation: replaces a sharp edge with a flat angled cut.
 *
 * Algorithm:
 * 1. Get the two adjacent faces of the edge.
 * 2. At each endpoint, compute offset points along both faces at the chamfer distance.
 * 3. Create the chamfer face (a quad connecting the four offset points).
 * 4. Trim adjacent faces to connect to the chamfer boundary.
 */
export class ChamferOperation {
  execute(engine: IGeometryEngine, params: ChamferParams): ChamferResult {
    const { edgeId, distance, distanceA, distanceB } = params;
    const dA = distanceA ?? distance;
    const dB = distanceB ?? distance;

    if (dA <= EPSILON || dB <= EPSILON) {
      return { success: false, chamferFaceId: null, newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: 'Distances must be positive' };
    }

    const edge = engine.getEdge(edgeId);
    if (!edge) {
      return { success: false, chamferFaceId: null, newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: `Edge ${edgeId} not found` };
    }

    const adjacentFaces = engine.getEdgeFaces(edgeId);
    if (adjacentFaces.length !== 2) {
      return { success: false, chamferFaceId: null, newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: 'Chamfer requires exactly 2 adjacent faces' };
    }

    const startVertex = engine.getVertex(edge.startVertexId)!;
    const endVertex = engine.getVertex(edge.endVertexId)!;
    const edgeDir = vec3.normalize(vec3.sub(endVertex.position, startVertex.position));

    const n0 = engine.computeFaceNormal(adjacentFaces[0].id);
    const n1 = engine.computeFaceNormal(adjacentFaces[1].id);

    // Compute tangent directions along each face, perpendicular to edge
    const tangent0 = vec3.normalize(vec3.cross(edgeDir, n0));
    const tangent1 = vec3.normalize(vec3.cross(n1, edgeDir));

    const newVertexIds: string[] = [];
    const newEdgeIds: string[] = [];

    // Chamfer creates 4 new vertices: 2 at each endpoint of the original edge
    // At start vertex: offset along tangent0 and tangent1
    const startA = engine.createVertex(vec3.add(startVertex.position, vec3.mul(tangent0, dA)));
    const startB = engine.createVertex(vec3.add(startVertex.position, vec3.mul(tangent1, dB)));
    newVertexIds.push(startA.id, startB.id);

    // At end vertex: offset along tangent0 and tangent1
    const endA = engine.createVertex(vec3.add(endVertex.position, vec3.mul(tangent0, dA)));
    const endB = engine.createVertex(vec3.add(endVertex.position, vec3.mul(tangent1, dB)));
    newVertexIds.push(endA.id, endB.id);

    // Create the chamfer face (quad)
    const chamferFace = engine.createFace([startA.id, endA.id, endB.id, startB.id]);

    // Create edges for the chamfer
    const e1 = engine.createEdge(startA.id, endA.id);
    const e2 = engine.createEdge(endA.id, endB.id);
    const e3 = engine.createEdge(endB.id, startB.id);
    const e4 = engine.createEdge(startB.id, startA.id);
    newEdgeIds.push(e1.id, e2.id, e3.id, e4.id);

    // Remove the original sharp edge
    engine.deleteEdge(edgeId);

    return {
      success: true,
      chamferFaceId: chamferFace.id,
      newEdgeIds,
      newVertexIds,
      removedEdgeId: edgeId,
    };
  }
}
