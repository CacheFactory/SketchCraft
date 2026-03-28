// @archigraph op.array
// Linear and polar array modifier for SketchCraft

import { Vec3 } from '../../src/core/types';
import { IGeometryEngine, IFace, IVertex, IEdge } from '../../src/core/interfaces';
import { vec3, EPSILON } from '../../src/core/math';

export type ArrayType = 'linear' | 'polar';

export interface LinearArrayParams {
  type: 'linear';
  faceIds: string[];
  direction: Vec3;           // direction and distance of each step
  count: number;             // total copies (including original = false, excluding = true)
  includeOriginal?: boolean; // default: false (count is number of new copies)
}

export interface PolarArrayParams {
  type: 'polar';
  faceIds: string[];
  axis: Vec3;       // rotation axis direction
  center: Vec3;     // center of rotation
  count: number;    // total instances around the circle
  angle?: number;   // total angle in radians (default: 2*PI = full circle)
}

export type ArrayParams = LinearArrayParams | PolarArrayParams;

export interface ArrayResult {
  success: boolean;
  /** Array of copy groups; each group contains the face/edge/vertex IDs for one copy */
  copies: Array<{
    faceIds: string[];
    edgeIds: string[];
    vertexIds: string[];
  }>;
  error?: string;
}

/**
 * Array Modifier: duplicates geometry N times with a transform offset.
 *
 * Supports:
 * - Linear array: translate by a fixed vector each step.
 * - Polar array: rotate around an axis/center each step.
 */
export class ArrayModifier {
  execute(engine: IGeometryEngine, params: ArrayParams): ArrayResult {
    if (params.count < 1) {
      return { success: false, copies: [], error: 'Count must be at least 1' };
    }

    if (params.faceIds.length === 0) {
      return { success: false, copies: [], error: 'No faces specified' };
    }

    if (params.type === 'linear') {
      return this.executeLinear(engine, params);
    } else {
      return this.executePolar(engine, params);
    }
  }

  private executeLinear(engine: IGeometryEngine, params: LinearArrayParams): ArrayResult {
    const { faceIds, direction, count } = params;
    const copies: ArrayResult['copies'] = [];

    // Collect all unique vertices from the source faces
    const sourceVertexIds = this.collectUniqueVertices(engine, faceIds);

    for (let step = 1; step <= count; step++) {
      const offset = vec3.mul(direction, step);
      const copy = this.duplicateGeometry(engine, faceIds, sourceVertexIds, (pos) =>
        vec3.add(pos, offset),
      );
      copies.push(copy);
    }

    return { success: true, copies };
  }

  private executePolar(engine: IGeometryEngine, params: PolarArrayParams): ArrayResult {
    const { faceIds, axis, center, count, angle = Math.PI * 2 } = params;
    const copies: ArrayResult['copies'] = [];

    const axisNorm = vec3.normalize(axis);
    const sourceVertexIds = this.collectUniqueVertices(engine, faceIds);

    // Angular step between copies. For full circle, divide evenly
    // and skip the last one (which would overlap the original).
    const stepAngle = angle / count;

    for (let step = 1; step < count; step++) {
      const theta = stepAngle * step;
      const copy = this.duplicateGeometry(engine, faceIds, sourceVertexIds, (pos) =>
        this.rotatePointAroundAxis(pos, center, axisNorm, theta),
      );
      copies.push(copy);
    }

    return { success: true, copies };
  }

  /** Collect all unique vertex IDs referenced by the given faces */
  private collectUniqueVertices(engine: IGeometryEngine, faceIds: string[]): string[] {
    const vertexIdSet = new Set<string>();
    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;
      for (const vid of face.vertexIds) {
        vertexIdSet.add(vid);
      }
    }
    return Array.from(vertexIdSet);
  }

  /**
   * Duplicate geometry by creating new vertices (transformed), edges, and faces.
   */
  private duplicateGeometry(
    engine: IGeometryEngine,
    faceIds: string[],
    sourceVertexIds: string[],
    transformPos: (pos: Vec3) => Vec3,
  ): { faceIds: string[]; edgeIds: string[]; vertexIds: string[] } {
    const vertexMap = new Map<string, string>(); // old -> new
    const newVertexIds: string[] = [];
    const newEdgeIds: string[] = [];
    const newFaceIds: string[] = [];

    // Create transformed copies of all vertices
    for (const vid of sourceVertexIds) {
      const v = engine.getVertex(vid);
      if (!v) continue;
      const newPos = transformPos(v.position);
      const newVertex = engine.createVertex(newPos);
      vertexMap.set(vid, newVertex.id);
      newVertexIds.push(newVertex.id);
    }

    // Track created edges to avoid duplicates
    const createdEdges = new Set<string>();

    // Recreate faces with mapped vertex IDs
    for (const faceId of faceIds) {
      const face = engine.getFace(faceId);
      if (!face) continue;

      const newVerts = face.vertexIds.map(vid => vertexMap.get(vid) ?? vid);
      const newFace = engine.createFace(newVerts);
      newFaceIds.push(newFace.id);

      // Create edges for the new face
      for (let i = 0; i < newVerts.length; i++) {
        const j = (i + 1) % newVerts.length;
        const edgeKey = [newVerts[i], newVerts[j]].sort().join('|');
        if (!createdEdges.has(edgeKey)) {
          createdEdges.add(edgeKey);
          const existing = engine.findEdgeBetween(newVerts[i], newVerts[j]);
          if (!existing) {
            const e = engine.createEdge(newVerts[i], newVerts[j]);
            newEdgeIds.push(e.id);
          }
        }
      }
    }

    return { faceIds: newFaceIds, edgeIds: newEdgeIds, vertexIds: newVertexIds };
  }

  /**
   * Rotate a point around an axis through a center point using Rodrigues' formula.
   */
  private rotatePointAroundAxis(point: Vec3, center: Vec3, axis: Vec3, angle: number): Vec3 {
    // Translate to origin
    const p = vec3.sub(point, center);

    // Rodrigues' rotation
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const kDotP = vec3.dot(axis, p);
    const kCrossP = vec3.cross(axis, p);

    const rotated = vec3.add(
      vec3.add(vec3.mul(p, cosA), vec3.mul(kCrossP, sinA)),
      vec3.mul(axis, kDotP * (1 - cosA)),
    );

    // Translate back
    return vec3.add(rotated, center);
  }
}
