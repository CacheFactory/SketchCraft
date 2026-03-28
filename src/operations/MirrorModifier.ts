// @archigraph op.mirror
// Mirror modifier for SketchCraft

import { Vec3, Plane } from '../core/types';
import { IGeometryEngine, IFace, IVertex } from '../core/interfaces';
import { vec3, EPSILON } from '../core/math';

export interface MirrorParams {
  faceIds: string[];      // faces to mirror
  plane: Plane;           // mirror plane (normal + distance)
  mergeThreshold?: number; // distance within which mirrored vertices merge with originals (default: EPSILON)
  deleteOriginal?: boolean; // if true, remove original geometry (default: false)
}

export interface MirrorResult {
  success: boolean;
  newFaceIds: string[];
  newEdgeIds: string[];
  newVertexIds: string[];
  mergedVertexIds: string[]; // vertices that were merged (on the mirror plane)
  error?: string;
}

/**
 * Mirror Modifier: mirrors geometry across a plane.
 *
 * Algorithm:
 * 1. For each vertex, compute its reflection across the mirror plane.
 * 2. If a reflected vertex is within mergeThreshold of an existing vertex, merge them.
 * 3. Create mirrored faces with reversed winding (to maintain outward normals).
 * 4. Create edges for the mirrored faces.
 */
export class MirrorModifier {
  execute(engine: IGeometryEngine, params: MirrorParams): MirrorResult {
    const {
      faceIds,
      plane,
      mergeThreshold = EPSILON * 100,
      deleteOriginal = false,
    } = params;

    if (faceIds.length === 0) {
      return { success: false, newFaceIds: [], newEdgeIds: [], newVertexIds: [], mergedVertexIds: [], error: 'No faces specified' };
    }

    const newVertexIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newFaceIds: string[] = [];
    const mergedVertexIds: string[] = [];

    // Collect all unique vertices from source faces
    const sourceVertexIdSet = new Set<string>();
    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;
      for (const vid of face.vertexIds) {
        sourceVertexIdSet.add(vid);
      }
    }

    // Map from original vertex ID to mirrored vertex ID
    const vertexMap = new Map<string, string>();

    for (const vid of sourceVertexIdSet) {
      const v = engine.getVertex(vid);
      if (!v) continue;

      const reflected = this.reflectPoint(v.position, plane);

      // Check if the reflected position is close to the original (vertex on mirror plane)
      if (vec3.distance(reflected, v.position) < mergeThreshold) {
        // Vertex is on the mirror plane; map to itself
        vertexMap.set(vid, vid);
        mergedVertexIds.push(vid);
        continue;
      }

      // Check if the reflected position is close to any existing source vertex
      let merged = false;
      for (const existingVid of sourceVertexIdSet) {
        if (existingVid === vid) continue;
        const ev = engine.getVertex(existingVid);
        if (ev && vec3.distance(reflected, ev.position) < mergeThreshold) {
          vertexMap.set(vid, existingVid);
          mergedVertexIds.push(existingVid);
          merged = true;
          break;
        }
      }

      if (!merged) {
        // Create a new mirrored vertex
        const newVertex = engine.createVertex(reflected);
        vertexMap.set(vid, newVertex.id);
        newVertexIds.push(newVertex.id);
      }
    }

    // Create mirrored faces with reversed winding order
    const createdEdges = new Set<string>();

    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      // Map and reverse vertex order for correct normal orientation
      const mirroredVerts = face.vertexIds
        .map(vid => vertexMap.get(vid) ?? vid)
        .reverse();

      // Skip if mirrored face is identical to original (all vertices mapped to themselves)
      const isIdentical = face.vertexIds.every((vid, i) =>
        vertexMap.get(vid) === vid,
      );
      if (isIdentical) continue;

      const newFace = engine.createFace(mirroredVerts);
      newFaceIds.push(newFace.id);

      // Create edges
      for (let i = 0; i < mirroredVerts.length; i++) {
        const j = (i + 1) % mirroredVerts.length;
        const edgeKey = [mirroredVerts[i], mirroredVerts[j]].sort().join('|');
        if (!createdEdges.has(edgeKey)) {
          createdEdges.add(edgeKey);
          const existing = engine.findEdgeBetween(mirroredVerts[i], mirroredVerts[j]);
          if (!existing) {
            const e = engine.createEdge(mirroredVerts[i], mirroredVerts[j]);
            newEdgeIds.push(e.id);
          }
        }
      }
    }

    // Optionally delete original geometry
    if (deleteOriginal) {
      for (const faceId of faceIds) {
        engine.deleteFace(faceId);
      }
    }

    return {
      success: true,
      newFaceIds,
      newEdgeIds,
      newVertexIds,
      mergedVertexIds,
    };
  }

  /**
   * Reflect a point across a plane.
   * reflected = point - 2 * (dot(point, normal) - distance) * normal
   */
  private reflectPoint(point: Vec3, plane: Plane): Vec3 {
    const dist = vec3.dot(point, plane.normal) - plane.distance;
    return vec3.sub(point, vec3.mul(plane.normal, 2 * dist));
  }
}
