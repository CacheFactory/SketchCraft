// @archigraph op.fillet
// Edge filleting operation for SketchCraft

import { Vec3 } from '../../src/core/types';
import { IGeometryEngine, IFace, IEdge, IVertex } from '../../src/core/interfaces';
import { vec3, EPSILON } from '../../src/core/math';

export interface FilletParams {
  edgeId: string;
  radius: number;
  segments?: number; // number of arc segments (default: 8)
}

export interface FilletResult {
  success: boolean;
  filletFaceIds: string[];
  newEdgeIds: string[];
  newVertexIds: string[];
  removedEdgeId: string | null;
  error?: string;
}

/**
 * Fillet Operation: replaces a sharp edge with a smooth arc of faces.
 *
 * Algorithm:
 * 1. Get the two adjacent faces of the edge.
 * 2. Compute the fillet arc center and radius in the cross-section plane.
 * 3. Generate arc vertices along the fillet profile at each end of the edge.
 * 4. Create fillet faces (quad strips) connecting arc vertices.
 * 5. Trim the adjacent faces to meet the fillet boundary.
 */
export class FilletOperation {
  execute(engine: IGeometryEngine, params: FilletParams): FilletResult {
    const { edgeId, radius, segments = 8 } = params;

    if (radius <= EPSILON) {
      return { success: false, filletFaceIds: [], newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: 'Radius must be positive' };
    }

    const edge = engine.getEdge(edgeId);
    if (!edge) {
      return { success: false, filletFaceIds: [], newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: `Edge ${edgeId} not found` };
    }

    const adjacentFaces = engine.getEdgeFaces(edgeId);
    if (adjacentFaces.length !== 2) {
      return { success: false, filletFaceIds: [], newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: 'Fillet requires exactly 2 adjacent faces' };
    }

    const startVertex = engine.getVertex(edge.startVertexId)!;
    const endVertex = engine.getVertex(edge.endVertexId)!;

    const edgeDir = vec3.normalize(vec3.sub(endVertex.position, startVertex.position));
    const n0 = engine.computeFaceNormal(adjacentFaces[0].id);
    const n1 = engine.computeFaceNormal(adjacentFaces[1].id);

    // Compute the angle between the two faces
    const faceAngle = vec3.angle(n0, n1);
    if (faceAngle < EPSILON || Math.abs(faceAngle - Math.PI) < EPSILON) {
      return { success: false, filletFaceIds: [], newEdgeIds: [], newVertexIds: [], removedEdgeId: null, error: 'Faces are parallel or coplanar; cannot fillet' };
    }

    // The fillet arc sweeps in the plane perpendicular to the edge direction.
    // Compute two tangent directions (pointing away from edge into each face).
    // These are the directions along each face, perpendicular to the edge.
    const tangent0 = vec3.normalize(vec3.cross(edgeDir, n0));
    const tangent1 = vec3.normalize(vec3.cross(n1, edgeDir));

    // The arc sweeps from tangent0 to tangent1 around the edge
    const filletAngle = Math.PI - faceAngle;

    const newVertexIds: string[] = [];
    const newEdgeIds: string[] = [];
    const filletFaceIds: string[] = [];

    // Generate arc vertices at start and end of the edge
    const arcVerticesStart: string[] = [];
    const arcVerticesEnd: string[] = [];

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = filletAngle * t;

      // Rotate tangent0 toward tangent1 by angle around edgeDir
      const arcDir = this.rotateVectorAroundAxis(tangent0, edgeDir, angle);
      const offset = vec3.mul(arcDir, radius);

      // Create vertex at start of edge
      const posStart = vec3.add(startVertex.position, offset);
      const vStart = engine.createVertex(posStart);
      arcVerticesStart.push(vStart.id);
      newVertexIds.push(vStart.id);

      // Create vertex at end of edge
      const posEnd = vec3.add(endVertex.position, offset);
      const vEnd = engine.createVertex(posEnd);
      arcVerticesEnd.push(vEnd.id);
      newVertexIds.push(vEnd.id);
    }

    // Create fillet face strips between start and end arcs
    for (let i = 0; i < segments; i++) {
      const face = engine.createFace([
        arcVerticesStart[i],
        arcVerticesEnd[i],
        arcVerticesEnd[i + 1],
        arcVerticesStart[i + 1],
      ]);
      filletFaceIds.push(face.id);
    }

    // Create edges along the arcs
    for (let i = 0; i < segments; i++) {
      const e1 = engine.createEdge(arcVerticesStart[i], arcVerticesStart[i + 1]);
      const e2 = engine.createEdge(arcVerticesEnd[i], arcVerticesEnd[i + 1]);
      const e3 = engine.createEdge(arcVerticesStart[i], arcVerticesEnd[i]);
      newEdgeIds.push(e1.id, e2.id, e3.id);
    }
    // Final connecting edge
    const eFinal = engine.createEdge(
      arcVerticesStart[segments],
      arcVerticesEnd[segments],
    );
    newEdgeIds.push(eFinal.id);

    // Remove the original sharp edge
    engine.deleteEdge(edgeId);

    return {
      success: true,
      filletFaceIds,
      newEdgeIds,
      newVertexIds,
      removedEdgeId: edgeId,
    };
  }

  /** Rotate a vector around an axis by the given angle (Rodrigues' rotation formula) */
  private rotateVectorAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const k = vec3.normalize(axis);

    // v_rot = v*cos(a) + (k x v)*sin(a) + k*(k.v)*(1 - cos(a))
    const kCrossV = vec3.cross(k, v);
    const kDotV = vec3.dot(k, v);

    return vec3.add(
      vec3.add(vec3.mul(v, cosA), vec3.mul(kCrossV, sinA)),
      vec3.mul(k, kDotV * (1 - cosA)),
    );
  }
}
