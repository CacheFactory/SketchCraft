// @archigraph op.extrude
// Push/Pull extrusion operation for SketchCraft

import { Vec3 } from '../../src/core/types';
import { IGeometryEngine, IFace, IVertex, IEdge } from '../../src/core/interfaces';
import { vec3, EPSILON } from '../../src/core/math';

export interface ExtrudeParams {
  faceId: string;
  distance: number; // positive = along normal, negative = reverse
}

export interface ExtrudeResult {
  success: boolean;
  newFaceId: string | null;        // the moved original face at new position
  sideFaceIds: string[];            // faces created along the extrusion sides
  newEdgeIds: string[];             // new edges created
  newVertexIds: string[];           // new vertices created
  error?: string;
}

export class ExtrudeOperation {
  /**
   * Extrudes a face along its normal by the given distance.
   *
   * Algorithm:
   * 1. Get the face and its ordered vertices/edges.
   * 2. Compute the extrusion direction (face normal * distance).
   * 3. Duplicate each vertex at offset position.
   * 4. Create side faces connecting original edges to new edges.
   * 5. Delete the original face and create a new cap face from the new vertices.
   */
  execute(engine: IGeometryEngine, params: ExtrudeParams): ExtrudeResult {
    const { faceId, distance } = params;

    if (Math.abs(distance) < EPSILON) {
      return { success: false, newFaceId: null, sideFaceIds: [], newEdgeIds: [], newVertexIds: [], error: 'Distance is zero' };
    }

    const face = engine.getFace(faceId);
    if (!face) {
      return { success: false, newFaceId: null, sideFaceIds: [], newEdgeIds: [], newVertexIds: [], error: `Face ${faceId} not found` };
    }

    const faceVertices = engine.getFaceVertices(faceId);
    if (faceVertices.length < 3) {
      return { success: false, newFaceId: null, sideFaceIds: [], newEdgeIds: [], newVertexIds: [], error: 'Face has fewer than 3 vertices' };
    }

    // Compute extrusion vector
    const normal = engine.computeFaceNormal(faceId);
    const extrudeVec = vec3.mul(normal, distance);

    const newVertexIds: string[] = [];
    const newEdgeIds: string[] = [];
    const sideFaceIds: string[] = [];

    // Map from original vertex ID to new (extruded) vertex ID
    const vertexMap = new Map<string, string>();

    // Step 1: Create new vertices at offset positions
    for (const v of faceVertices) {
      const newPos = vec3.add(v.position, extrudeVec);
      const newVertex = engine.createVertex(newPos);
      vertexMap.set(v.id, newVertex.id);
      newVertexIds.push(newVertex.id);
    }

    // Step 2: Create edges between new vertices (the new cap edges)
    const orderedVertexIds = face.vertexIds;
    const newCapVertexIds: string[] = orderedVertexIds.map(vid => vertexMap.get(vid)!);

    for (let i = 0; i < newCapVertexIds.length; i++) {
      const j = (i + 1) % newCapVertexIds.length;
      const edge = engine.createEdge(newCapVertexIds[i], newCapVertexIds[j]);
      newEdgeIds.push(edge.id);
    }

    // Step 3: Create vertical edges connecting original to new vertices
    const verticalEdgeIds: string[] = [];
    for (const vid of orderedVertexIds) {
      const newVid = vertexMap.get(vid)!;
      const edge = engine.createEdge(vid, newVid);
      verticalEdgeIds.push(edge.id);
      newEdgeIds.push(edge.id);
    }

    // Step 4: Create side faces
    // Each side face connects an original edge to the corresponding new edge
    // via two vertical edges, forming a quad.
    for (let i = 0; i < orderedVertexIds.length; i++) {
      const j = (i + 1) % orderedVertexIds.length;

      const origA = orderedVertexIds[i];
      const origB = orderedVertexIds[j];
      const newA = vertexMap.get(origA)!;
      const newB = vertexMap.get(origB)!;

      // Side face winding: origA -> origB -> newB -> newA
      // This ensures the normal faces outward (away from the extrusion volume)
      const sideFace = engine.createFace([origA, origB, newB, newA]);
      sideFaceIds.push(sideFace.id);
    }

    // Step 5: Create the new cap face from the new vertices
    // Preserve the same winding order as the original face
    const newFace = engine.createFace(newCapVertexIds);

    // Step 6: Delete the original face (it is now interior to the extrusion)
    engine.deleteFace(faceId);

    return {
      success: true,
      newFaceId: newFace.id,
      sideFaceIds,
      newEdgeIds,
      newVertexIds,
    };
  }
}
