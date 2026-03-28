// @archigraph op.smooth
// Smooth/soften edges modifier for SketchCraft

import { IGeometryEngine, IEdge, IFace } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';

export interface SmoothParams {
  /** Edge IDs to process. Empty = all edges in the mesh. */
  edgeIds?: string[];
  /** Angle threshold in radians. Edges between faces with dihedral angle
   *  less than this are smoothed/softened. */
  angleThreshold: number;
  /** Set the soft flag (hides edge line in rendering). Default: true */
  setSoft?: boolean;
  /** Set the smooth flag (interpolates normals across the edge). Default: true */
  setSmooth?: boolean;
}

export interface SmoothResult {
  success: boolean;
  smoothedEdgeIds: string[];   // edges that were smoothed
  hardEdgeIds: string[];       // edges that remain hard
  error?: string;
}

/**
 * Smooth Modifier: sets soft/smooth flags on edges based on the dihedral
 * angle between adjacent faces.
 *
 * - Soft edges are not rendered as visible lines (cosmetic).
 * - Smooth edges interpolate vertex normals across the edge (affects shading).
 *
 * Edges with a dihedral angle below the threshold are smoothed.
 * Edges above the threshold remain hard (visible crease).
 */
export class SmoothModifier {
  execute(engine: IGeometryEngine, params: SmoothParams): SmoothResult {
    const {
      edgeIds,
      angleThreshold,
      setSoft = true,
      setSmooth = true,
    } = params;

    const mesh = engine.getMesh();

    const targetEdgeIds = edgeIds && edgeIds.length > 0
      ? edgeIds
      : Array.from(mesh.edges.keys());

    const smoothedEdgeIds: string[] = [];
    const hardEdgeIds: string[] = [];

    for (const edgeId of targetEdgeIds) {
      const edge = engine.getEdge(edgeId);
      if (!edge) continue;

      const adjFaces = engine.getEdgeFaces(edgeId);

      if (adjFaces.length !== 2) {
        // Boundary or non-manifold edge: keep hard
        hardEdgeIds.push(edgeId);
        continue;
      }

      // Compute dihedral angle between the two faces
      const n0 = engine.computeFaceNormal(adjFaces[0].id);
      const n1 = engine.computeFaceNormal(adjFaces[1].id);
      const dihedralAngle = vec3.angle(n0, n1);

      if (dihedralAngle <= angleThreshold) {
        // Smooth this edge
        edge.soft = setSoft;
        edge.smooth = setSmooth;
        smoothedEdgeIds.push(edgeId);
      } else {
        // Keep hard
        edge.soft = false;
        edge.smooth = false;
        hardEdgeIds.push(edgeId);
      }
    }

    return {
      success: true,
      smoothedEdgeIds,
      hardEdgeIds,
    };
  }
}
