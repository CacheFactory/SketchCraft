// @archigraph engine.geometry
// Implementation of IGeometryEngine using half-edge B-Rep topology

import { v4 as uuid } from 'uuid';
import {
  IVertex, IEdge, IFace, IHalfEdge, IMesh, IGeometryEngine,
} from '../../src/core/interfaces';
import { Vec3, Ray, BoundingBox, Plane } from '../../src/core/types';
import { vec3, ray as rayUtil, bbox, EPSILON } from '../../src/core/math';
import { HalfEdgeMesh } from '../mesh.halfedge/HalfEdgeMesh';

// ─── Binary format constants ────────────────────────────────────
const MAGIC = 0x534B4347; // 'SKCG'
const VERSION = 2;

// Vertex hit radius for raycasting (world units)
const VERTEX_HIT_RADIUS = 0.05;
// Edge hit radius for raycasting (world units)
const EDGE_HIT_RADIUS = 0.02;

/**
 * Geometry engine implementing B-Rep via half-edge mesh topology.
 * All entity IDs are UUIDs. Float64 precision throughout.
 */
export class GeometryEngine implements IGeometryEngine {
  private mesh: HalfEdgeMesh;

  /**
   * Optional guard: returns true if the given face/edge ID is in a protected component
   * and should NOT be intersected/split by new geometry.
   * Set by Application after scene manager is initialized.
   */
  isProtectedEntity: ((entityId: string) => boolean) | null = null;

  constructor() {
    this.mesh = new HalfEdgeMesh();
  }

  /** Expose internal mesh for delta-based undo/redo wiring. */
  getInternalMesh(): HalfEdgeMesh {
    return this.mesh;
  }

  // ─── Create operations ──────────────────────────────────────────

  createVertex(position: Vec3): IVertex {
    return this.mesh.addVertex(position);
  }

  createEdge(v1Id: string, v2Id: string): IEdge {
    // Guard: no self-edges
    if (v1Id === v2Id) throw new Error('Cannot create edge between a vertex and itself');

    const v1 = this.mesh.vertices.get(v1Id);
    const v2 = this.mesh.vertices.get(v2Id);
    if (!v1) throw new Error(`Vertex ${v1Id} not found`);
    if (!v2) throw new Error(`Vertex ${v2Id} not found`);

    // Guard: no zero-length edges
    const dx = v1.position.x - v2.position.x;
    const dy = v1.position.y - v2.position.y;
    const dz = v1.position.z - v2.position.z;
    if (dx * dx + dy * dy + dz * dz < 1e-10) {
      throw new Error('Cannot create zero-length edge');
    }

    // Check if edge already exists
    const existing = this.mesh.findEdgeBetween(v1Id, v2Id);
    if (existing) return existing;

    return this.mesh.addEdge(v1Id, v2Id);
  }

  /**
   * Create an edge AND check if it completes a closed coplanar loop.
   * If so, automatically create a face. Call this from tools like LineTool
   * that want SketchUp-style auto-face behavior.
   */
  createEdgeWithAutoFace(v1Id: string, v2Id: string): IEdge {
    // Guard against self-edges or zero-length
    if (v1Id === v2Id) {
      // Return existing edge if any, otherwise throw
      const existing = this.mesh.findEdgeBetween(v1Id, v2Id);
      if (existing) return existing;
      throw new Error('Cannot create self-edge');
    }
    const v1 = this.mesh.vertices.get(v1Id);
    const v2 = this.mesh.vertices.get(v2Id);
    if (v1 && v2 && vec3.distanceSq(v1.position, v2.position) < 1e-10) {
      const existing = this.mesh.findEdgeBetween(v1Id, v2Id);
      if (existing) return existing;
      throw new Error('Cannot create zero-length edge');
    }

    // Check for face bisection BEFORE creating the edge
    const bisectedFaceId = this.findBisectedFace(v1Id, v2Id);

    const edge = this.createEdge(v1Id, v2Id);

    // If this edge bisects an existing face, split it
    if (bisectedFaceId) {
      this.splitFaceWithEdge(bisectedFaceId, v1Id, v2Id);
    }

    // Also try to auto-create new faces from closed loops
    this.autoCreateFaces(v1Id, v2Id);

    return edge;
  }

  /**
   * Create an edge from v1 to v2, detecting intersections with existing face boundary edges.
   * At each intersection, a new vertex is created, the boundary edge is split, and the face
   * boundary is updated. After all intersections are processed, edges are created between
   * consecutive intersection points, and faces are split/auto-created.
   * This is the core SketchUp behavior for drawing on existing geometry.
   */
  createEdgeWithIntersection(v1Id: string, v2Id: string): IEdge[] {
    const v1 = this.mesh.vertices.get(v1Id);
    const v2 = this.mesh.vertices.get(v2Id);
    if (!v1 || !v2) throw new Error('Vertex not found');
    if (v1Id === v2Id) throw new Error('Cannot create self-edge');

    const p1 = v1.position;
    const p2 = v2.position;

    // Collect intersection points along the segment p1→p2
    const intersections: Array<{ t: number; vertexId: string }> = [];

    // Snapshot face IDs to avoid mutation during iteration
    const faceIds = [...this.mesh.faces.keys()];

    for (const faceId of faceIds) {
      // Skip faces in protected components
      if (this.isProtectedEntity?.(faceId)) continue;

      const face = this.mesh.faces.get(faceId);
      if (!face) continue;
      const verts = face.vertexIds;
      for (let i = 0; i < verts.length; i++) {
        const nextI = (i + 1) % verts.length;
        const vaId = verts[i];
        const vbId = verts[nextI];
        const va = this.mesh.vertices.get(vaId);
        const vb = this.mesh.vertices.get(vbId);
        if (!va || !vb) continue;

        // Skip boundary edges that share a vertex with the new edge
        if (vaId === v1Id || vaId === v2Id || vbId === v1Id || vbId === v2Id) continue;

        const result = this.segmentIntersect2D(p1, p2, va.position, vb.position);
        if (!result) continue;

        // Check if there's already an intersection vertex nearby
        const intPoint = vec3.add(p1, vec3.mul(vec3.sub(p2, p1), result.t1));
        let existingId: string | null = null;
        for (const int of intersections) {
          const existing = this.mesh.vertices.get(int.vertexId);
          if (existing && vec3.distance(existing.position, intPoint) < 0.01) {
            existingId = int.vertexId;
            break;
          }
        }
        // Also check existing vertices
        if (!existingId) {
          for (const [vid, vert] of this.mesh.vertices) {
            if (vec3.distance(vert.position, intPoint) < 0.01) {
              existingId = vid;
              break;
            }
          }
        }

        const intVertexId = existingId ?? this.mesh.addVertex(intPoint).id;

        if (!existingId) {
          // Split the boundary edge at this point
          const existingEdge = this.mesh.findEdgeBetween(vaId, vbId);
          if (existingEdge) {
            const curveId = existingEdge.curveId;
            this.mesh.removeEdge(existingEdge.id);
            const e1 = this.mesh.addEdge(vaId, intVertexId);
            const e2 = this.mesh.addEdge(intVertexId, vbId);
            if (curveId) { e1.curveId = curveId; e2.curveId = curveId; }
          }

          // Insert the vertex into ALL faces that have this boundary edge
          for (const [, f] of this.mesh.faces) {
            const fv = f.vertexIds;
            for (let j = 0; j < fv.length; j++) {
              const nextJ = (j + 1) % fv.length;
              if ((fv[j] === vaId && fv[nextJ] === vbId) || (fv[j] === vbId && fv[nextJ] === vaId)) {
                fv.splice(j + 1, 0, intVertexId);
                break;
              }
            }
          }
        }

        // Avoid duplicate intersections at the same t
        if (!intersections.some(x => Math.abs(x.t - result.t1) < 1e-6)) {
          intersections.push({ t: result.t1, vertexId: intVertexId });
        }
      }
    }

    // Sort intersections by parameter t along the new edge
    intersections.sort((a, b) => a.t - b.t);

    // Build the chain of vertices: v1 → int1 → int2 → ... → v2
    const chain = [v1Id, ...intersections.map(i => i.vertexId), v2Id];

    // Create edges along the chain
    const createdEdges: IEdge[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      if (chain[i] === chain[i + 1]) continue;
      try {
        const edge = this.createEdge(chain[i], chain[i + 1]);
        createdEdges.push(edge);
      } catch {
        const existing = this.mesh.findEdgeBetween(chain[i], chain[i + 1]);
        if (existing) createdEdges.push(existing);
      }
    }

    // Use splitFaceWithPath to handle vertices that lie on face boundary edges.
    // This splits those boundary edges, inserts the vertices into face boundaries,
    // and splits any bisected faces. This is the proven approach used by arc tools.
    this.splitFaceWithPath(chain);

    // Also run auto-face detection for each segment to find closed loops
    for (let i = 0; i < chain.length - 1; i++) {
      if (chain[i] === chain[i + 1]) continue;
      this.autoCreateFaces(chain[i], chain[i + 1]);
    }
    console.log('[createEdgeWithIntersection] after autoCreateFaces, faces:', this.mesh.faces.size);

    return createdEdges;
  }

  /**
   * 2D segment-segment intersection (ignoring Y axis, using X and Z).
   * Returns { t1, t2 } parameters along each segment, or null if no intersection.
   * Both t1 and t2 must be in (epsilon, 1-epsilon) for a proper crossing.
   */
  private segmentIntersect2D(
    a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3
  ): { t1: number; t2: number } | null {
    // Use the plane with the largest projected area for numerical stability
    const aNorm = vec3.cross(vec3.sub(a2, a1), vec3.sub(b2, b1));
    const absX = Math.abs(aNorm.x), absY = Math.abs(aNorm.y), absZ = Math.abs(aNorm.z);

    let u1: number, v1_: number, u2: number, v2_: number;
    let u3: number, v3: number, u4: number, v4: number;

    if (absY >= absX && absY >= absZ) {
      // Project onto XZ plane (most common for ground-plane geometry)
      u1 = a1.x; v1_ = a1.z; u2 = a2.x; v2_ = a2.z;
      u3 = b1.x; v3 = b1.z; u4 = b2.x; v4 = b2.z;
    } else if (absX >= absZ) {
      // Project onto YZ plane
      u1 = a1.y; v1_ = a1.z; u2 = a2.y; v2_ = a2.z;
      u3 = b1.y; v3 = b1.z; u4 = b2.y; v4 = b2.z;
    } else {
      // Project onto XY plane
      u1 = a1.x; v1_ = a1.y; u2 = a2.x; v2_ = a2.y;
      u3 = b1.x; v3 = b1.y; u4 = b2.x; v4 = b2.y;
    }

    const d1u = u2 - u1, d1v = v2_ - v1_;
    const d2u = u4 - u3, d2v = v4 - v3;

    const denom = d1u * d2v - d1v * d2u;
    if (Math.abs(denom) < 1e-10) return null; // Parallel or collinear

    const du = u3 - u1, dv = v3 - v1_;
    const t1 = (du * d2v - dv * d2u) / denom;
    const t2 = (du * d1v - dv * d1u) / denom;

    const EPS = 0.001;
    if (t1 < EPS || t1 > 1 - EPS || t2 < EPS || t2 > 1 - EPS) return null;

    // Verify the segments are coplanar (within tolerance)
    const int3d_a = vec3.add(a1, vec3.mul(vec3.sub(a2, a1), t1));
    const int3d_b = vec3.add(b1, vec3.mul(vec3.sub(b2, b1), t2));
    if (vec3.distance(int3d_a, int3d_b) > 0.1) return null; // Not coplanar

    return { t1, t2 };
  }

  /**
   * Find a face whose boundary contains both v1 and v2 (but they're not adjacent).
   * This means the new edge would bisect the face.
   */
  private findBisectedFace(v1Id: string, v2Id: string): string | null {
    for (const [faceId, face] of this.mesh.faces) {
      // Skip faces in protected components
      if (this.isProtectedEntity?.(faceId)) continue;

      const verts = face.vertexIds;
      const idx1 = verts.indexOf(v1Id);
      const idx2 = verts.indexOf(v2Id);

      if (idx1 === -1 || idx2 === -1) continue;
      if (verts.length < 4) continue; // Can't split a triangle

      // Check they're NOT adjacent (adjacent = splitting would create a degenerate face)
      const n = verts.length;
      const diff = Math.abs(idx1 - idx2);
      if (diff === 1 || diff === n - 1) continue; // Adjacent vertices

      return faceId;
    }
    return null;
  }

  /**
   * Split a face into two faces along two boundary vertices.
   * Optionally includes interior path vertices (for arc/path splitting).
   * Both v1Id and v2Id must be on the face's boundary.
   */
  private splitFaceAtBoundary(
    faceId: string, v1Id: string, v2Id: string, pathInterior: string[] = [],
  ): boolean {
    const face = this.mesh.faces.get(faceId);
    if (!face) return false;

    const verts = face.vertexIds;
    const idx1 = verts.indexOf(v1Id);
    const idx2 = verts.indexOf(v2Id);
    if (idx1 === -1 || idx2 === -1) return false;

    const n = verts.length;
    const diff = Math.abs(idx1 - idx2);
    if (diff === 1 || diff === n - 1) return false; // Adjacent — can't split

    const lo = Math.min(idx1, idx2);
    const hi = Math.max(idx1, idx2);
    const isV1Lo = idx1 <= idx2;

    // Boundary side 1: vertices from lo to hi (inclusive)
    const side1: string[] = [];
    for (let i = lo; i <= hi; i++) side1.push(verts[i]);

    // Boundary side 2: vertices from hi to lo (wrapping)
    const side2: string[] = [];
    for (let i = hi; i !== lo; i = (i + 1) % n) side2.push(verts[i]);
    side2.push(verts[lo]);

    let faceA: string[];
    let faceB: string[];

    if (pathInterior.length === 0) {
      // Simple edge split — no interior vertices
      faceA = side1;
      faceB = side2;
    } else if (isV1Lo) {
      faceA = [...side1, ...pathInterior.slice().reverse()];
      faceB = [verts[lo], ...pathInterior, verts[hi]];
      for (let i = (hi + 1) % n; i !== lo; i = (i + 1) % n) faceB.push(verts[i]);
    } else {
      faceA = [...side1, ...pathInterior.slice()];
      faceB = [verts[hi], ...pathInterior.slice().reverse(), verts[lo]];
      for (let i = (lo + 1) % n; i !== hi; i = (i + 1) % n) faceB.push(verts[i]);
    }

    this.deleteFace(faceId);

    if (faceA.length >= 3) {
      try { this.createFace(faceA); } catch {}
    }
    if (faceB.length >= 3) {
      try { this.createFace(faceB); } catch {}
    }
    return true;
  }

  /** Split a face along an edge between two boundary vertices. */
  private splitFaceWithEdge(faceId: string, v1Id: string, v2Id: string): void {
    this.splitFaceAtBoundary(faceId, v1Id, v2Id);
  }

  /**
   * After a new edge (v1, v2) is created, search for closed loops in the edge graph.
   * If a loop is found and all vertices are coplanar, create a face automatically.
   * This is the core SketchUp behavior: closing a loop of edges creates a face.
   */
  private autoCreateFaces(v1Id: string, v2Id: string): void {
    // Find ALL short coplanar loops that include the new edge.
    // BFS from v2 to v1 through other edges, collecting all paths.
    const maxDepth = 20;

    const findAllLoops = (startId: string, targetId: string): string[][] => {
      const loops: string[][] = [];
      const queue: Array<{ vertexId: string; path: string[] }> = [
        { vertexId: startId, path: [startId] },
      ];

      while (queue.length > 0) {
        const { vertexId, path } = queue.shift()!;
        if (path.length > maxDepth) continue;

        const edges = this.mesh.getVertexEdges(vertexId);
        for (const edge of edges) {
          if ((edge.startVertexId === v1Id && edge.endVertexId === v2Id) ||
              (edge.startVertexId === v2Id && edge.endVertexId === v1Id)) {
            continue;
          }

          const neighborId = edge.startVertexId === vertexId ? edge.endVertexId : edge.startVertexId;

          if (neighborId === targetId && path.length >= 2) {
            loops.push([...path, targetId]);
            continue;
          }

          if (!path.includes(neighborId)) {
            queue.push({ vertexId: neighborId, path: [...path, neighborId] });
          }
        }
      }
      return loops;
    };

    const loops = findAllLoops(v2Id, v1Id);

    // Sort by length (shortest first) — minimal loops are the real faces
    loops.sort((a, b) => a.length - b.length);

    for (const loop of loops) {
      if (loop.length < 3) continue;
      if (!this.checkCoplanar(loop)) continue;

      // Check that no face already exists with these exact vertices
      let exists = false;
      for (const [, face] of this.mesh.faces) {
        if (face.vertexIds.length === loop.length) {
          const faceSet = new Set(face.vertexIds);
          if (loop.every(v => faceSet.has(v))) { exists = true; break; }
        }
      }
      if (exists) continue;

      // MINIMAL LOOP CHECK 1: skip if any two non-adjacent loop vertices
      // have an unprotected edge between them (a "chord").
      // Protected (component) edges don't count as chords.
      let hasChord = false;
      for (let i = 0; i < loop.length && !hasChord; i++) {
        for (let j = i + 2; j < loop.length; j++) {
          if (i === 0 && j === loop.length - 1) continue;
          const chord = this.mesh.findEdgeBetween(loop[i], loop[j]);
          if (chord && !this.isProtectedEntity?.(chord.id)) {
            hasChord = true;
            break;
          }
        }
      }
      if (hasChord) continue;

      // MINIMAL LOOP CHECK 2: skip if any coplanar vertex with edges lies
      // geometrically inside the loop polygon. Such a vertex means the loop
      // encloses smaller faces and is not minimal.
      if (this.loopContainsInteriorVertex(loop)) continue;

      try {
        this.createFace(loop);
      } catch {
        // Silently ignore
      }
    }
  }

  /**
   * Check if a candidate face loop contains any vertex in its interior.
   * Projects the loop and all coplanar vertices onto the loop's 2D plane,
   * then uses a ray-casting point-in-polygon test.
   */
  private loopContainsInteriorVertex(loop: string[]): boolean {
    if (loop.length < 3) return false;

    const positions = loop.map(id => {
      const v = this.mesh.vertices.get(id);
      return v ? v.position : null;
    });
    if (positions.some(p => !p)) return false;
    const pos = positions as Vec3[];

    // Compute loop plane normal
    const v01 = vec3.sub(pos[1], pos[0]);
    const v02 = vec3.sub(pos[2], pos[0]);
    const normal = vec3.normalize(vec3.cross(v01, v02));
    if (vec3.length(normal) < 1e-8) return false;
    const planeDist = vec3.dot(normal, pos[0]);

    // Build 2D projection axes on the plane
    let axisU = vec3.normalize(v01);
    let axisV = vec3.normalize(vec3.cross(normal, axisU));

    // Project loop vertices to 2D
    const loopSet = new Set(loop);
    const poly2D = pos.map(p => ({
      u: vec3.dot(vec3.sub(p, pos[0]), axisU),
      v: vec3.dot(vec3.sub(p, pos[0]), axisV),
    }));

    // Check all mesh vertices not in the loop
    for (const [vid, vert] of this.mesh.vertices) {
      if (loopSet.has(vid)) continue;

      // Must be coplanar
      const distToPlane = Math.abs(vec3.dot(normal, vert.position) - planeDist);
      if (distToPlane > 0.05) continue;

      // Must have at least one edge (isolated vertices don't matter)
      const vertEdges = this.mesh.getVertexEdges(vid);
      if (vertEdges.length === 0) continue;

      // Skip vertices that only belong to protected components — they shouldn't
      // prevent face creation for unprotected geometry
      if (this.isProtectedEntity) {
        const allProtected = vertEdges.every(e => this.isProtectedEntity!(e.id));
        if (allProtected) continue;
      }

      // Project to 2D and do point-in-polygon test (ray casting)
      const pu = vec3.dot(vec3.sub(vert.position, pos[0]), axisU);
      const pv = vec3.dot(vec3.sub(vert.position, pos[0]), axisV);

      let inside = false;
      for (let i = 0, j = poly2D.length - 1; i < poly2D.length; j = i++) {
        const ui = poly2D[i].u, vi = poly2D[i].v;
        const uj = poly2D[j].u, vj = poly2D[j].v;
        if (((vi > pv) !== (vj > pv)) &&
            (pu < (uj - ui) * (pv - vi) / (vj - vi) + ui)) {
          inside = !inside;
        }
      }

      if (inside) return true;
    }

    return false;
  }

  /**
   * Split any face that is bisected by a path of vertices (e.g., an arc from A to B).
   * If the first and last vertex of the path are both on a face boundary,
   * that face is split into two: one side includes the path, the other side
   * includes the remaining boundary vertices.
   */
  splitFaceWithPath(pathVertexIds: string[]): void {
    if (pathVertexIds.length < 2) return;

    // Collect face IDs first to avoid mutating the map during iteration
    const faceIds = [...this.mesh.faces.keys()];

    for (const faceId of faceIds) {
      // Skip faces in protected components
      if (this.isProtectedEntity?.(faceId)) continue;

      const face = this.mesh.faces.get(faceId);
      if (!face) continue;

      let verts = [...face.vertexIds];

      // For each path vertex, if it's not in the vertex list,
      // check if it lies ON one of the face's edges and insert it
      for (const checkId of pathVertexIds) {
        if (verts.includes(checkId)) continue;

        const checkVert = this.mesh.vertices.get(checkId);
        if (!checkVert) continue;

        let inserted = false;
        for (let i = 0; i < verts.length && !inserted; i++) {
          const nextI = (i + 1) % verts.length;
          const va = this.mesh.vertices.get(verts[i]);
          const vb = this.mesh.vertices.get(verts[nextI]);
          if (!va || !vb) continue;

          const edgeDir = vec3.sub(vb.position, va.position);
          const edgeLen = vec3.length(edgeDir);
          if (edgeLen < 1e-10) continue;

          const toPoint = vec3.sub(checkVert.position, va.position);
          const t = vec3.dot(toPoint, edgeDir) / (edgeLen * edgeLen);
          if (t < -0.01 || t > 1.01) continue;

          const closest = vec3.add(va.position, vec3.mul(edgeDir, t));
          if (vec3.distance(closest, checkVert.position) < 0.05) {
            verts.splice(i + 1, 0, checkId);

            // The original edge was between verts[i] and the vertex now at i+2
            // Use modular indexing to handle the wrapping edge case
            const nextAfterInsert = (i + 2) % verts.length;
            const existingEdge = this.mesh.findEdgeBetween(verts[i], verts[nextAfterInsert]);
            if (existingEdge) {
              this.mesh.removeEdge(existingEdge.id);
              this.mesh.addEdge(verts[i], checkId);
              this.mesh.addEdge(checkId, verts[nextAfterInsert]);
            }
            inserted = true;
          }
        }
      }

      face.vertexIds = verts;

      // Find the first and last path vertices that are on this face's boundary.
      // The line may extend beyond the face, so the chain endpoints may not be
      // on the boundary — we need to find the actual entry/exit points.
      let splitStart: string | null = null;
      let splitEnd: string | null = null;
      let splitStartIdx = -1;
      let splitEndIdx = -1;

      for (let i = 0; i < pathVertexIds.length; i++) {
        if (verts.includes(pathVertexIds[i])) {
          if (splitStart === null) {
            splitStart = pathVertexIds[i];
            splitStartIdx = i;
          }
          splitEnd = pathVertexIds[i];
          splitEndIdx = i;
        }
      }

      if (!splitStart || !splitEnd || splitStart === splitEnd) continue;

      // Extract the interior path vertices between splitStart and splitEnd
      const pathInterior = pathVertexIds.slice(splitStartIdx + 1, splitEndIdx);

      this.splitFaceAtBoundary(faceId, splitStart, splitEnd, pathInterior);
      // Don't return — continue checking other faces
    }
  }

  createFace(vertexIds: string[]): IFace {
    // Guard: remove duplicate consecutive vertices
    const cleaned: string[] = [];
    for (let i = 0; i < vertexIds.length; i++) {
      const prev = i === 0 ? vertexIds[vertexIds.length - 1] : vertexIds[i - 1];
      if (vertexIds[i] !== prev) cleaned.push(vertexIds[i]);
    }
    vertexIds = cleaned;

    if (vertexIds.length < 3) {
      throw new Error('A face requires at least 3 unique vertices');
    }

    // Guard: no duplicate vertices in face
    const uniqueSet = new Set(vertexIds);
    if (uniqueSet.size < 3) {
      throw new Error('A face requires at least 3 unique vertices');
    }

    // Validate all vertices exist
    for (const vId of vertexIds) {
      if (!this.mesh.vertices.has(vId)) {
        throw new Error(`Vertex ${vId} not found`);
      }
    }

    // Check if a face with these exact vertices already exists
    const vertSet = new Set(vertexIds);
    for (const [, existing] of this.mesh.faces) {
      if (existing.vertexIds.length === vertexIds.length) {
        const existSet = new Set(existing.vertexIds);
        if (vertexIds.every(v => existSet.has(v))) {
          return existing; // Face already exists, return it
        }
      }
    }

    const { face } = this.mesh.createFaceFromVertices(
      vertexIds,
      (v1, v2) => this.mesh.findEdgeBetween(v1, v2),
    );

    return face;
  }

  // ─── Bulk import (fast path — skips per-entity topology checks) ──

  /**
   * Import pre-parsed OBJ geometry in bulk. Uses numeric IDs (not UUIDs),
   * hash-based edge dedup, and skips half-edge topology for maximum speed.
   * Returns the vertex IDs array (0-indexed, matching input order).
   */
  bulkImport(
    vertices: Vec3[],
    faces: number[][],
    standaloneEdges?: [number, number][],
    faceHoleStarts?: (number[] | undefined)[],
  ): { vertexIds: string[]; faceIds: string[] } {
    // For very large models (>10K faces), skip edge extraction to save ~30%+ memory.
    // These models use batched rendering (view-only, no per-entity selection).
    const SKIP_EDGES_THRESHOLD = 10000;
    const skipEdges = faces.length > SKIP_EDGES_THRESHOLD;

    // Clean faces and collect unique edge pairs (by vertex index)
    const edgeSet = skipEdges ? null : new Set<number>();
    const edgeKey = (a: number, b: number) => a < b ? a * 2000000 + b : b * 2000000 + a;
    const edgePairs: [number, number][] = [];

    const cleanedFaces: number[][] = [];
    // Track which input face indices survive cleaning (for UV/material mapping)
    const survivingInputIndices: number[] = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const faceIndices = faces[fi];
      if (faceIndices.length < 3) continue;
      let valid = true;
      const cleaned: number[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < faceIndices.length; i++) {
        const idx = faceIndices[i];
        if (idx < 0 || idx >= vertices.length) { valid = false; break; }
        const prev = i === 0 ? faceIndices[faceIndices.length - 1] : faceIndices[i - 1];
        if (idx !== prev && !seen.has(idx)) {
          cleaned.push(idx);
          seen.add(idx);
        }
      }
      if (!valid || cleaned.length < 3) continue;

      // Skip non-planar faces: compute normal from first 3 vertices, then check
      // that all remaining vertices lie within tolerance of that plane.
      const p0 = vertices[cleaned[0]], p1 = vertices[cleaned[1]], p2 = vertices[cleaned[2]];
      const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
      const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
      let fnx = e1y * e2z - e1z * e2y;
      let fny = e1z * e2x - e1x * e2z;
      let fnz = e1x * e2y - e1y * e2x;
      const flen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
      if (flen < 1e-10) continue; // degenerate triangle
      fnx /= flen; fny /= flen; fnz /= flen;
      const fd = fnx * p0.x + fny * p0.y + fnz * p0.z;

      let planar = true;
      for (let i = 3; i < cleaned.length; i++) {
        const pi = vertices[cleaned[i]];
        const dist = Math.abs(fnx * pi.x + fny * pi.y + fnz * pi.z - fd);
        if (dist > 0.01) { planar = false; break; }
      }
      if (!planar) continue;

      cleanedFaces.push(cleaned);
      survivingInputIndices.push(fi);

      if (!skipEdges) {
        // Create edges per loop (outer + holes) to avoid bridge edges
        const holes = faceHoleStarts?.[fi];
        if (holes && holes.length > 0) {
          // Build loop boundaries: [0, hole0, hole1, ..., cleaned.length]
          const loopStarts = [0, ...holes, cleaned.length];
          for (let li = 0; li < loopStarts.length - 1; li++) {
            const start = loopStarts[li];
            const end = loopStarts[li + 1];
            for (let i = start; i < end; i++) {
              const a = cleaned[i];
              const b = cleaned[i + 1 < end ? i + 1 : start];
              const k = edgeKey(a, b);
              if (!edgeSet!.has(k)) { edgeSet!.add(k); edgePairs.push([a, b]); }
            }
          }
        } else {
          for (let i = 0; i < cleaned.length; i++) {
            const a = cleaned[i], b = cleaned[(i + 1) % cleaned.length];
            const k = edgeKey(a, b);
            if (!edgeSet!.has(k)) { edgeSet!.add(k); edgePairs.push([a, b]); }
          }
        }
      }
    }

    if (!skipEdges && standaloneEdges) {
      for (const [a, b] of standaloneEdges) {
        if (a >= 0 && b >= 0 && a < vertices.length && b < vertices.length) {
          const k = edgeKey(a, b);
          if (!edgeSet!.has(k)) { edgeSet!.add(k); edgePairs.push([a, b]); }
        }
      }
    }

    if (skipEdges) {
      console.log(`[bulkImport] Skipping edge creation for ${faces.length} faces (view-only mode, saves ~30% memory)`);
    }

    // Fast bulk add to mesh — numeric IDs, no UUIDs, no half-edges
    const result = this.mesh.bulkAdd(vertices, cleanedFaces, edgePairs);
    // Expose survivingInputIndices on the result for UV/material mapping
    (result as any).survivingInputIndices = survivingInputIndices;
    return result;
  }

  // ─── Delete operations ──────────────────────────────────────────

  deleteVertex(id: string): void {
    // Remove all edges connected to this vertex
    const edges = this.mesh.getVertexEdges(id);
    for (const edge of edges) {
      this.deleteEdge(edge.id);
    }
    this.mesh.removeVertex(id);
  }

  deleteEdge(id: string): void {
    // Remove all faces that use this edge
    const faces = this.mesh.getEdgeFaces(id);
    for (const face of faces) {
      this.deleteFace(face.id);
    }
    this.mesh.removeEdge(id);
  }

  deleteFace(id: string): void {
    // Remove face and its half-edges, leave edges and vertices
    this.mesh.removeFace(id);
  }

  // ─── Get operations ─────────────────────────────────────────────

  getVertex(id: string): IVertex | undefined {
    return this.mesh.vertices.get(id);
  }

  getEdge(id: string): IEdge | undefined {
    return this.mesh.edges.get(id);
  }

  getFace(id: string): IFace | undefined {
    return this.mesh.faces.get(id);
  }

  // ─── Topology queries ──────────────────────────────────────────

  getVertexEdges(vertexId: string): IEdge[] {
    return this.mesh.getVertexEdges(vertexId);
  }

  /** Get face IDs incident to a vertex (for dirty-tracking adjacency). */
  getVertexFaces(vertexId: string): string[] {
    return this.mesh.getVertexFaces(vertexId);
  }

  /** Get edge IDs incident to a vertex (for dirty-tracking adjacency). */
  getVertexEdgeIds(vertexId: string): string[] {
    return this.mesh.getVertexEdgeIds(vertexId);
  }

  getEdgeFaces(edgeId: string): IFace[] {
    return this.mesh.getEdgeFaces(edgeId);
  }

  getFaceEdges(faceId: string): IEdge[] {
    return this.mesh.getFaceEdges(faceId);
  }

  getFaceVertices(faceId: string): IVertex[] {
    return this.mesh.getFaceVertices(faceId);
  }

  getConnectedFaces(faceId: string): IFace[] {
    return this.mesh.getConnectedFaces(faceId);
  }

  findEdgeBetween(v1Id: string, v2Id: string): IEdge | undefined {
    return this.mesh.findEdgeBetween(v1Id, v2Id);
  }

  getCurveEdges(curveId: string): IEdge[] {
    const edges: IEdge[] = [];
    for (const [, edge] of this.mesh.edges) {
      if (edge.curveId === curveId) edges.push(edge);
    }
    return edges;
  }

  // ─── Geometry computations ─────────────────────────────────────

  checkCoplanar(vertexIds: string[]): boolean {
    if (vertexIds.length <= 3) return true;

    const positions = vertexIds.map(id => {
      const v = this.mesh.vertices.get(id);
      if (!v) throw new Error(`Vertex ${id} not found`);
      return v.position;
    });

    // Compute plane from first 3 points
    const v01 = vec3.sub(positions[1], positions[0]);
    const v02 = vec3.sub(positions[2], positions[0]);
    const normal = vec3.normalize(vec3.cross(v01, v02));

    if (vec3.length(normal) < EPSILON) {
      // Degenerate: first 3 points are collinear
      return true;
    }

    const d = vec3.dot(normal, positions[0]);

    // Check remaining points
    for (let i = 3; i < positions.length; i++) {
      const dist = Math.abs(vec3.dot(normal, positions[i]) - d);
      if (dist > 0.05) return false; // Practical tolerance for hand-drawn geometry
    }

    return true;
  }

  computeFaceNormal(faceId: string): Vec3 {
    const face = this.mesh.faces.get(faceId);
    if (!face) throw new Error(`Face ${faceId} not found`);

    const positions = face.vertexIds.map(id => {
      const v = this.mesh.vertices.get(id);
      if (!v) throw new Error(`Vertex ${id} not found`);
      return v.position;
    });

    return this.mesh.computePolygonNormal(positions);
  }

  computeFaceArea(faceId: string): number {
    const face = this.mesh.faces.get(faceId);
    if (!face) throw new Error(`Face ${faceId} not found`);

    const positions = face.vertexIds.map(id => {
      const v = this.mesh.vertices.get(id);
      if (!v) throw new Error(`Vertex ${id} not found`);
      return v.position;
    });

    const normal = this.mesh.computePolygonNormal(positions);
    return this.mesh.computePolygonArea(positions, normal);
  }

  computeEdgeLength(edgeId: string): number {
    const edge = this.mesh.edges.get(edgeId);
    if (!edge) throw new Error(`Edge ${edgeId} not found`);

    const v1 = this.mesh.vertices.get(edge.startVertexId);
    const v2 = this.mesh.vertices.get(edge.endVertexId);
    if (!v1 || !v2) throw new Error('Edge vertices not found');

    return vec3.distance(v1.position, v2.position);
  }

  // ─── Raycasting ─────────────────────────────────────────────────

  raycast(r: Ray): Array<{ entityId: string; point: Vec3; distance: number; type: 'vertex' | 'edge' | 'face' }> {
    const hits: Array<{ entityId: string; point: Vec3; distance: number; type: 'vertex' | 'edge' | 'face' }> = [];
    const dir = vec3.normalize(r.direction);
    const normalizedRay: Ray = { origin: r.origin, direction: dir };

    // Test vertices
    for (const [, vertex] of this.mesh.vertices) {
      if (vertex.hidden) continue;
      const dist = rayUtil.distanceToPoint(normalizedRay, vertex.position);
      if (dist < VERTEX_HIT_RADIUS) {
        const proj = vec3.dot(vec3.sub(vertex.position, r.origin), dir);
        if (proj > 0) {
          hits.push({
            entityId: vertex.id,
            point: vec3.clone(vertex.position),
            distance: proj,
            type: 'vertex',
          });
        }
      }
    }

    // Test edges
    for (const [, edge] of this.mesh.edges) {
      if (edge.hidden) continue;
      const v1 = this.mesh.vertices.get(edge.startVertexId);
      const v2 = this.mesh.vertices.get(edge.endVertexId);
      if (!v1 || !v2) continue;

      const hit = this.rayEdgeIntersect(normalizedRay, v1.position, v2.position);
      if (hit && hit.distance > 0 && hit.closestDist < EDGE_HIT_RADIUS) {
        hits.push({
          entityId: edge.id,
          point: hit.point,
          distance: hit.distance,
          type: 'edge',
        });
      }
    }

    // Test faces
    for (const [, face] of this.mesh.faces) {
      if (face.hidden) continue;
      const hit = this.rayFaceIntersect(normalizedRay, face);
      if (hit) {
        hits.push({
          entityId: face.id,
          point: hit.point,
          distance: hit.distance,
          type: 'face',
        });
      }
    }

    // Sort by distance
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /**
   * Ray-edge closest approach test.
   */
  private rayEdgeIntersect(
    r: Ray,
    p1: Vec3,
    p2: Vec3,
  ): { point: Vec3; distance: number; closestDist: number } | null {
    const d = vec3.sub(p2, p1);
    const w = vec3.sub(r.origin, p1);
    const a = vec3.dot(r.direction, r.direction); // 1 if normalized
    const b = vec3.dot(r.direction, d);
    const c = vec3.dot(d, d);
    const dd = vec3.dot(r.direction, w);
    const e = vec3.dot(d, w);

    const denom = a * c - b * b;
    if (Math.abs(denom) < EPSILON) return null; // Parallel

    let tRay = (b * e - c * dd) / denom;
    let tEdge = (a * e - b * dd) / denom;

    // Clamp edge parameter
    tEdge = Math.max(0, Math.min(1, tEdge));
    // Recompute ray parameter for clamped edge point
    tRay = vec3.dot(vec3.sub(vec3.add(p1, vec3.mul(d, tEdge)), r.origin), r.direction);

    if (tRay < 0) return null;

    const rayPoint = vec3.add(r.origin, vec3.mul(r.direction, tRay));
    const edgePoint = vec3.add(p1, vec3.mul(d, tEdge));
    const closestDist = vec3.distance(rayPoint, edgePoint);

    return { point: edgePoint, distance: tRay, closestDist };
  }

  /**
   * Ray-face intersection using Moller-Trumbore for triangulated fan.
   */
  private rayFaceIntersect(
    r: Ray,
    face: IFace,
  ): { point: Vec3; distance: number } | null {
    const positions = face.vertexIds.map(id => {
      const v = this.mesh.vertices.get(id);
      return v ? v.position : null;
    });
    if (positions.some(p => p === null)) return null;
    const pts = positions as Vec3[];

    if (pts.length < 3) return null;

    // Fan triangulation from vertex 0
    let closestHit: { point: Vec3; distance: number } | null = null;

    for (let i = 1; i < pts.length - 1; i++) {
      const hit = this.rayTriangleIntersect(r, pts[0], pts[i], pts[i + 1]);
      if (hit && (!closestHit || hit.distance < closestHit.distance)) {
        closestHit = hit;
      }
    }

    return closestHit;
  }

  /**
   * Moller-Trumbore ray-triangle intersection.
   */
  private rayTriangleIntersect(
    r: Ray,
    v0: Vec3,
    v1: Vec3,
    v2: Vec3,
  ): { point: Vec3; distance: number } | null {
    const edge1 = vec3.sub(v1, v0);
    const edge2 = vec3.sub(v2, v0);
    const h = vec3.cross(r.direction, edge2);
    const a = vec3.dot(edge1, h);

    if (Math.abs(a) < EPSILON) return null; // Ray parallel to triangle

    const f = 1.0 / a;
    const s = vec3.sub(r.origin, v0);
    const u = f * vec3.dot(s, h);
    if (u < 0.0 || u > 1.0) return null;

    const q = vec3.cross(s, edge1);
    const v = f * vec3.dot(r.direction, q);
    if (v < 0.0 || u + v > 1.0) return null;

    const t = f * vec3.dot(edge2, q);
    if (t < EPSILON) return null; // Intersection behind ray origin

    const point = vec3.add(r.origin, vec3.mul(r.direction, t));
    return { point, distance: t };
  }

  // ─── Bounding box ──────────────────────────────────────────────

  getBoundingBox(): BoundingBox {
    let box = bbox.empty();
    for (const [, vertex] of this.mesh.vertices) {
      box = bbox.expandByPoint(box, vertex.position);
    }
    return box;
  }

  // ─── Mesh access ───────────────────────────────────────────────

  getMesh(): IMesh {
    return this.mesh.toMesh();
  }

  // ─── Clone ─────────────────────────────────────────────────────

  clone(): IGeometryEngine {
    const engine = new GeometryEngine();
    engine.mesh = this.mesh.clone();
    return engine;
  }

  // ─── Serialization ─────────────────────────────────────────────

  /**
   * Binary format:
   * [MAGIC: u32] [VERSION: u32]
   * [numVertices: u32] [numEdges: u32] [numFaces: u32] [numHalfEdges: u32]
   *
   * Vertices: for each vertex:
   *   [idLength: u16] [id: utf8 bytes] [x: f64] [y: f64] [z: f64]
   *   [selected: u8] [hidden: u8]
   *
   * Edges: for each edge:
   *   [idLength: u16] [id: utf8] [startIdLen: u16] [startId: utf8]
   *   [endIdLen: u16] [endId: utf8] [soft: u8] [smooth: u8]
   *   [selected: u8] [hidden: u8] [materialIndex: i32]
   *
   * Faces: for each face:
   *   [idLength: u16] [id: utf8] [numVerts: u32]
   *   for each vert: [idLen: u16] [id: utf8]
   *   [nx: f64] [ny: f64] [nz: f64] [planeDist: f64]
   *   [materialIndex: i32] [backMaterialIndex: i32]
   *   [selected: u8] [hidden: u8] [area: f64]
   *
   * HalfEdges: for each halfEdge:
   *   [idLen: u16] [id: utf8]
   *   [originIdLen: u16] [originId: utf8]
   *   [hasTwin: u8] [twinIdLen: u16] [twinId: utf8] (if hasTwin)
   *   [nextIdLen: u16] [nextId: utf8]
   *   [prevIdLen: u16] [prevId: utf8]
   *   [hasFace: u8] [faceIdLen: u16] [faceId: utf8] (if hasFace)
   *   [edgeIdLen: u16] [edgeId: utf8]
   */
  serialize(): ArrayBuffer {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    const pushU8 = (val: number) => {
      const buf = new Uint8Array(1);
      buf[0] = val;
      chunks.push(buf);
      totalSize += 1;
    };

    const pushU16 = (val: number) => {
      const buf = new ArrayBuffer(2);
      new DataView(buf).setUint16(0, val, true);
      chunks.push(new Uint8Array(buf));
      totalSize += 2;
    };

    const pushU32 = (val: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, val, true);
      chunks.push(new Uint8Array(buf));
      totalSize += 4;
    };

    const pushI32 = (val: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setInt32(0, val, true);
      chunks.push(new Uint8Array(buf));
      totalSize += 4;
    };

    const pushF64 = (val: number) => {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, val, true);
      chunks.push(new Uint8Array(buf));
      totalSize += 8;
    };

    const pushString = (str: string) => {
      const encoded = encoder.encode(str);
      pushU16(encoded.length);
      chunks.push(encoded);
      totalSize += encoded.length;
    };

    // Header
    pushU32(MAGIC);
    pushU32(VERSION);
    pushU32(this.mesh.vertices.size);
    pushU32(this.mesh.edges.size);
    pushU32(this.mesh.faces.size);
    pushU32(this.mesh.halfEdges.size);

    // Vertices
    for (const [, v] of this.mesh.vertices) {
      pushString(v.id);
      pushF64(v.position.x);
      pushF64(v.position.y);
      pushF64(v.position.z);
      pushU8(v.selected ? 1 : 0);
      pushU8(v.hidden ? 1 : 0);
    }

    // Edges
    for (const [, e] of this.mesh.edges) {
      pushString(e.id);
      pushString(e.startVertexId);
      pushString(e.endVertexId);
      pushU8(e.soft ? 1 : 0);
      pushU8(e.smooth ? 1 : 0);
      pushU8(e.selected ? 1 : 0);
      pushU8(e.hidden ? 1 : 0);
      pushI32(e.materialIndex);
      pushU8(e.curveId ? 1 : 0);
      if (e.curveId) pushString(e.curveId);
    }

    // Faces
    for (const [, f] of this.mesh.faces) {
      pushString(f.id);
      pushU32(f.vertexIds.length);
      for (const vId of f.vertexIds) {
        pushString(vId);
      }
      pushF64(f.normal.x);
      pushF64(f.normal.y);
      pushF64(f.normal.z);
      pushF64(f.plane.distance);
      pushI32(f.materialIndex);
      pushI32(f.backMaterialIndex);
      pushU8(f.selected ? 1 : 0);
      pushU8(f.hidden ? 1 : 0);
      pushF64(f.area);
      const holes = f.holeStartIndices || [];
      pushU32(holes.length);
      for (const hi of holes) pushU32(hi);
      // UVs (texture coordinates from OBJ import)
      const uvs = f.uvs || [];
      pushU32(uvs.length);
      for (const uv of uvs) {
        pushF64(uv.u);
        pushF64(uv.v);
      }
    }

    // Half-edges
    for (const [, he] of this.mesh.halfEdges) {
      pushString(he.id);
      pushString(he.originVertexId);
      pushU8(he.twinId ? 1 : 0);
      if (he.twinId) pushString(he.twinId);
      pushString(he.nextId);
      pushString(he.prevId);
      pushU8(he.faceId ? 1 : 0);
      if (he.faceId) pushString(he.faceId);
      pushString(he.edgeId);
    }

    // Concatenate all chunks
    const result = new ArrayBuffer(totalSize);
    const view = new Uint8Array(result);
    let offset = 0;
    for (const chunk of chunks) {
      view.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  deserialize(data: ArrayBuffer): void {
    const decoder = new TextDecoder();
    const view = new DataView(data);
    const bytes = new Uint8Array(data);
    let offset = 0;

    const readU8 = (): number => {
      const val = view.getUint8(offset);
      offset += 1;
      return val;
    };

    const readU16 = (): number => {
      const val = view.getUint16(offset, true);
      offset += 2;
      return val;
    };

    const readU32 = (): number => {
      const val = view.getUint32(offset, true);
      offset += 4;
      return val;
    };

    const readI32 = (): number => {
      const val = view.getInt32(offset, true);
      offset += 4;
      return val;
    };

    const readF64 = (): number => {
      const val = view.getFloat64(offset, true);
      offset += 8;
      return val;
    };

    const readString = (): string => {
      const len = readU16();
      const str = decoder.decode(bytes.slice(offset, offset + len));
      offset += len;
      return str;
    };

    // Header
    const magic = readU32();
    if (magic !== MAGIC) throw new Error('Invalid geometry data: bad magic number');
    const version = readU32();
    if (version !== 1 && version !== 2) throw new Error(`Unsupported geometry version: ${version}`);

    const numVertices = readU32();
    const numEdges = readU32();
    const numFaces = readU32();
    const numHalfEdges = readU32();

    // Clear existing mesh
    this.mesh = new HalfEdgeMesh();

    // Vertices
    for (let i = 0; i < numVertices; i++) {
      const id = readString();
      const x = readF64();
      const y = readF64();
      const z = readF64();
      const selected = readU8() === 1;
      const hidden = readU8() === 1;

      const v: IVertex = { id, position: { x, y, z }, selected, hidden };
      this.mesh.vertices.set(id, v);
    }

    // Edges
    for (let i = 0; i < numEdges; i++) {
      const id = readString();
      const startVertexId = readString();
      const endVertexId = readString();
      const soft = readU8() === 1;
      const smooth = readU8() === 1;
      const selected = readU8() === 1;
      const hidden = readU8() === 1;
      const materialIndex = readI32();

      const hasCurveId = readU8() === 1;
      const curveId = hasCurveId ? readString() : undefined;

      const e: IEdge = { id, startVertexId, endVertexId, soft, smooth, selected, hidden, materialIndex };
      if (curveId) e.curveId = curveId;
      this.mesh.edges.set(id, e);
    }

    // Faces
    for (let i = 0; i < numFaces; i++) {
      const id = readString();
      const numVerts = readU32();
      const vertexIds: string[] = [];
      for (let j = 0; j < numVerts; j++) {
        vertexIds.push(readString());
      }
      const nx = readF64();
      const ny = readF64();
      const nz = readF64();
      const planeDist = readF64();
      const materialIndex = readI32();
      const backMaterialIndex = readI32();
      const selected = readU8() === 1;
      const hidden = readU8() === 1;
      const area = readF64();
      const numHoles = readU32();
      const holeStartIndices: number[] = [];
      for (let j = 0; j < numHoles; j++) holeStartIndices.push(readU32());

      // UVs (version 2+)
      let uvs: Array<{ u: number; v: number }> | undefined;
      if (version >= 2) {
        const numUVs = readU32();
        if (numUVs > 0) {
          uvs = [];
          for (let j = 0; j < numUVs; j++) {
            uvs.push({ u: readF64(), v: readF64() });
          }
        }
      }

      const normal: Vec3 = { x: nx, y: ny, z: nz };
      const f: IFace = {
        id, vertexIds, normal,
        plane: { normal: { ...normal }, distance: planeDist },
        materialIndex, backMaterialIndex, selected, hidden, area,
        generation: 0,
      };
      if (holeStartIndices.length > 0) f.holeStartIndices = holeStartIndices;
      if (uvs) f.uvs = uvs;
      this.mesh.faces.set(id, f);
    }

    // Half-edges
    for (let i = 0; i < numHalfEdges; i++) {
      const id = readString();
      const originVertexId = readString();
      const hasTwin = readU8() === 1;
      const twinId = hasTwin ? readString() : null;
      const nextId = readString();
      const prevId = readString();
      const hasFace = readU8() === 1;
      const faceId = hasFace ? readString() : null;
      const edgeId = readString();

      const he: IHalfEdge = { id, originVertexId, twinId, nextId, prevId, faceId, edgeId };
      this.mesh.halfEdges.set(id, he);
    }
  }
}
