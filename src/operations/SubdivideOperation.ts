// @archigraph op.subdivide
// Mesh subdivision operation for SketchCraft

import { Vec3 } from '../core/types';
import { IGeometryEngine, IFace, IVertex, IEdge } from '../core/interfaces';
import { vec3 } from '../core/math';

export type SubdivisionMethod = 'catmull-clark' | 'midpoint';

export interface SubdivideParams {
  faceIds: string[];           // faces to subdivide (empty = all faces)
  method?: SubdivisionMethod;  // default: 'midpoint'
  iterations?: number;         // default: 1
}

export interface SubdivideResult {
  success: boolean;
  newFaceIds: string[];
  newEdgeIds: string[];
  newVertexIds: string[];
  removedFaceIds: string[];
  error?: string;
}

/**
 * Subdivide Operation: splits faces into smaller sub-faces.
 *
 * Supports two methods:
 * - midpoint: split each edge at its midpoint, connect midpoints to form sub-faces
 * - catmull-clark: smooth subdivision with face points, edge points, and updated vertices
 */
export class SubdivideOperation {
  execute(engine: IGeometryEngine, params: SubdivideParams): SubdivideResult {
    const { faceIds, method = 'midpoint', iterations = 1 } = params;

    let currentFaceIds = faceIds.length > 0
      ? [...faceIds]
      : Array.from(engine.getMesh().faces.keys());

    const allNewFaceIds: string[] = [];
    const allNewEdgeIds: string[] = [];
    const allNewVertexIds: string[] = [];
    const allRemovedFaceIds: string[] = [];

    for (let iter = 0; iter < iterations; iter++) {
      let result: SubdivideResult;

      if (method === 'catmull-clark') {
        result = this.catmullClark(engine, currentFaceIds);
      } else {
        result = this.midpointSubdivide(engine, currentFaceIds);
      }

      if (!result.success) {
        return result;
      }

      allNewFaceIds.push(...result.newFaceIds);
      allNewEdgeIds.push(...result.newEdgeIds);
      allNewVertexIds.push(...result.newVertexIds);
      allRemovedFaceIds.push(...result.removedFaceIds);

      // Next iteration works on newly created faces
      currentFaceIds = result.newFaceIds;
    }

    return {
      success: true,
      newFaceIds: allNewFaceIds,
      newEdgeIds: allNewEdgeIds,
      newVertexIds: allNewVertexIds,
      removedFaceIds: allRemovedFaceIds,
    };
  }

  /**
   * Simple midpoint subdivision: for each face, create a center vertex and
   * split each edge at its midpoint, then connect to form sub-faces.
   *
   * For a quad ABCD with midpoints Mab, Mbc, Mcd, Mda and center C:
   *   -> 4 quads: (A, Mab, C, Mda), (Mab, B, Mbc, C), (C, Mbc, C_face, Mcd), (Mda, C, Mcd, D)
   *
   * For a triangle ABC with midpoints Mab, Mbc, Mca:
   *   -> 4 triangles: (A, Mab, Mca), (Mab, B, Mbc), (Mca, Mbc, C), (Mab, Mbc, Mca)
   */
  private midpointSubdivide(engine: IGeometryEngine, faceIds: string[]): SubdivideResult {
    const newFaceIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newVertexIds: string[] = [];
    const removedFaceIds: string[] = [];

    // Cache edge midpoints so shared edges only get one midpoint vertex
    const edgeMidpointMap = new Map<string, string>(); // edgeId -> midpoint vertexId

    const getOrCreateEdgeMidpoint = (v1Id: string, v2Id: string): string => {
      // Look for existing edge between these vertices
      const edge = engine.findEdgeBetween(v1Id, v2Id);
      if (edge && edgeMidpointMap.has(edge.id)) {
        return edgeMidpointMap.get(edge.id)!;
      }

      const v1 = engine.getVertex(v1Id)!;
      const v2 = engine.getVertex(v2Id)!;
      const midPos = vec3.lerp(v1.position, v2.position, 0.5);
      const midVertex = engine.createVertex(midPos);
      newVertexIds.push(midVertex.id);

      if (edge) {
        edgeMidpointMap.set(edge.id, midVertex.id);
      }

      return midVertex.id;
    };

    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      const vertexIds = face.vertexIds;
      const n = vertexIds.length;

      if (n === 3) {
        // Triangle subdivision -> 4 triangles
        const mids = [
          getOrCreateEdgeMidpoint(vertexIds[0], vertexIds[1]),
          getOrCreateEdgeMidpoint(vertexIds[1], vertexIds[2]),
          getOrCreateEdgeMidpoint(vertexIds[2], vertexIds[0]),
        ];

        // 4 sub-triangles
        newFaceIds.push(engine.createFace([vertexIds[0], mids[0], mids[2]]).id);
        newFaceIds.push(engine.createFace([mids[0], vertexIds[1], mids[1]]).id);
        newFaceIds.push(engine.createFace([mids[2], mids[1], vertexIds[2]]).id);
        newFaceIds.push(engine.createFace([mids[0], mids[1], mids[2]]).id);

        // Create edges
        for (let i = 0; i < 3; i++) {
          const j = (i + 1) % 3;
          newEdgeIds.push(engine.createEdge(mids[i], mids[j]).id);
          newEdgeIds.push(engine.createEdge(vertexIds[i], mids[i]).id);
          newEdgeIds.push(engine.createEdge(mids[i], vertexIds[j]).id);
        }
      } else {
        // General polygon: create center vertex and split into quads
        const vertices = engine.getFaceVertices(faceId);
        const centerPos = this.computeCentroid(vertices);
        const centerVertex = engine.createVertex(centerPos);
        newVertexIds.push(centerVertex.id);

        const mids: string[] = [];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          mids.push(getOrCreateEdgeMidpoint(vertexIds[i], vertexIds[j]));
        }

        // Create N quad sub-faces
        for (let i = 0; i < n; i++) {
          const prevMid = mids[(i - 1 + n) % n];
          const nextMid = mids[i];
          const subFace = engine.createFace([vertexIds[i], nextMid, centerVertex.id, prevMid]);
          newFaceIds.push(subFace.id);

          // Edges from vertex to midpoint, midpoint to center
          newEdgeIds.push(engine.createEdge(vertexIds[i], nextMid).id);
          newEdgeIds.push(engine.createEdge(nextMid, centerVertex.id).id);
          newEdgeIds.push(engine.createEdge(centerVertex.id, prevMid).id);
        }
      }

      // Remove the original face
      engine.deleteFace(faceId);
      removedFaceIds.push(faceId);
    }

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      newVertexIds,
      removedFaceIds,
    };
  }

  /**
   * Catmull-Clark subdivision.
   *
   * For each face:
   * 1. Create a face point at the centroid.
   * 2. For each edge, create an edge point = average of edge midpoint and
   *    adjacent face points.
   * 3. Move original vertices toward average of adjacent face/edge points.
   * 4. Connect face point -> edge points -> vertex points to form new quads.
   */
  private catmullClark(engine: IGeometryEngine, faceIds: string[]): SubdivideResult {
    const newFaceIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newVertexIds: string[] = [];
    const removedFaceIds: string[] = [];

    const faceIdSet = new Set(faceIds);

    // Step 1: Compute face points
    const facePointMap = new Map<string, string>(); // faceId -> facePoint vertexId
    for (const faceId of faceIds) {
      const vertices = engine.getFaceVertices(faceId);
      if (vertices.length === 0) continue;
      const centroid = this.computeCentroid(vertices);
      const fp = engine.createVertex(centroid);
      facePointMap.set(faceId, fp.id);
      newVertexIds.push(fp.id);
    }

    // Step 2: Compute edge points
    // Edge point = average of (edge midpoint, adjacent face points)
    const edgePointMap = new Map<string, string>(); // edgeId -> edgePoint vertexId
    const processedEdges = new Set<string>();

    for (const faceId of faceIds) {
      const edges = engine.getFaceEdges(faceId);
      for (const edge of edges) {
        if (processedEdges.has(edge.id)) continue;
        processedEdges.add(edge.id);

        const v1 = engine.getVertex(edge.startVertexId)!;
        const v2 = engine.getVertex(edge.endVertexId)!;
        const edgeMid = vec3.lerp(v1.position, v2.position, 0.5);

        // Get adjacent face points
        const adjFaces = engine.getEdgeFaces(edge.id);
        const adjFacePoints: Vec3[] = [];
        for (const f of adjFaces) {
          const fpId = facePointMap.get(f.id);
          if (fpId) {
            adjFacePoints.push(engine.getVertex(fpId)!.position);
          }
        }

        let edgePoint: Vec3;
        if (adjFacePoints.length > 0) {
          let sum = edgeMid;
          for (const fp of adjFacePoints) {
            sum = vec3.add(sum, fp);
          }
          edgePoint = vec3.div(sum, 1 + adjFacePoints.length);
        } else {
          edgePoint = edgeMid;
        }

        const ep = engine.createVertex(edgePoint);
        edgePointMap.set(edge.id, ep.id);
        newVertexIds.push(ep.id);
      }
    }

    // Step 3: Create new sub-faces
    // For each original face, create quads connecting:
    // face point -> edge point -> original vertex -> edge point
    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      const vertexIds = face.vertexIds;
      const n = vertexIds.length;
      const fpId = facePointMap.get(faceId)!;

      for (let i = 0; i < n; i++) {
        const prevIdx = (i - 1 + n) % n;
        const vid = vertexIds[i];

        // Find edge between prev vertex and current vertex
        const prevEdge = engine.findEdgeBetween(vertexIds[prevIdx], vid);
        // Find edge between current vertex and next vertex
        const nextEdge = engine.findEdgeBetween(vid, vertexIds[(i + 1) % n]);

        if (!prevEdge || !nextEdge) continue;

        const prevEpId = edgePointMap.get(prevEdge.id);
        const nextEpId = edgePointMap.get(nextEdge.id);

        if (!prevEpId || !nextEpId) continue;

        // Create quad: prevEdgePoint -> vertex -> nextEdgePoint -> facePoint
        const subFace = engine.createFace([prevEpId, vid, nextEpId, fpId]);
        newFaceIds.push(subFace.id);

        // Create connecting edges
        newEdgeIds.push(engine.createEdge(prevEpId, vid).id);
        newEdgeIds.push(engine.createEdge(vid, nextEpId).id);
        newEdgeIds.push(engine.createEdge(nextEpId, fpId).id);
        newEdgeIds.push(engine.createEdge(fpId, prevEpId).id);
      }

      engine.deleteFace(faceId);
      removedFaceIds.push(faceId);
    }

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      newVertexIds,
      removedFaceIds,
    };
  }

  private computeCentroid(vertices: IVertex[]): Vec3 {
    let sum = vec3.zero();
    for (const v of vertices) {
      sum = vec3.add(sum, v.position);
    }
    return vec3.div(sum, vertices.length);
  }
}
