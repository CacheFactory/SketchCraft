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
const VERSION = 1;

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

  constructor() {
    this.mesh = new HalfEdgeMesh();
  }

  // ─── Create operations ──────────────────────────────────────────

  createVertex(position: Vec3): IVertex {
    return this.mesh.addVertex(position);
  }

  createEdge(v1Id: string, v2Id: string): IEdge {
    const v1 = this.mesh.vertices.get(v1Id);
    const v2 = this.mesh.vertices.get(v2Id);
    if (!v1) throw new Error(`Vertex ${v1Id} not found`);
    if (!v2) throw new Error(`Vertex ${v2Id} not found`);

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
   * Find a face whose boundary contains both v1 and v2 (but they're not adjacent).
   * This means the new edge would bisect the face.
   */
  private findBisectedFace(v1Id: string, v2Id: string): string | null {
    for (const [faceId, face] of this.mesh.faces) {
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
   * Split a face into two faces along the edge between v1 and v2.
   * Both v1 and v2 must be on the face's boundary.
   */
  private splitFaceWithEdge(faceId: string, v1Id: string, v2Id: string): void {
    const face = this.mesh.faces.get(faceId);
    if (!face) return;

    const verts = face.vertexIds;
    const idx1 = verts.indexOf(v1Id);
    const idx2 = verts.indexOf(v2Id);
    if (idx1 === -1 || idx2 === -1) return;

    // Ensure idx1 < idx2 for consistent splitting
    const lo = Math.min(idx1, idx2);
    const hi = Math.max(idx1, idx2);

    // Face 1: vertices from lo to hi (inclusive)
    const face1Verts: string[] = [];
    for (let i = lo; i <= hi; i++) {
      face1Verts.push(verts[i]);
    }

    // Face 2: vertices from hi to lo (wrapping around, inclusive)
    const face2Verts: string[] = [];
    for (let i = hi; i !== lo; i = (i + 1) % verts.length) {
      face2Verts.push(verts[i]);
    }
    face2Verts.push(verts[lo]);

    // Delete the original face
    this.deleteFace(faceId);

    // Create the two new faces (only if they have 3+ vertices)
    if (face1Verts.length >= 3) {
      try { this.createFace(face1Verts); } catch {}
    }
    if (face2Verts.length >= 3) {
      try { this.createFace(face2Verts); } catch {}
    }
  }

  /**
   * After a new edge (v1, v2) is created, search for closed loops in the edge graph.
   * If a loop is found and all vertices are coplanar, create a face automatically.
   * This is the core SketchUp behavior: closing a loop of edges creates a face.
   */
  private autoCreateFaces(v1Id: string, v2Id: string): void {
    // Find all short cycles that include the new edge (v1→v2)
    // Do a BFS from v2 trying to reach v1 through other edges
    const maxDepth = 12; // Max vertices in a face

    const findLoop = (startId: string, targetId: string): string[] | null => {
      // BFS to find shortest path from startId to targetId through edges
      const queue: Array<{ vertexId: string; path: string[] }> = [
        { vertexId: startId, path: [startId] },
      ];
      const visited = new Set<string>();
      visited.add(startId);

      while (queue.length > 0) {
        const { vertexId, path } = queue.shift()!;
        if (path.length > maxDepth) continue;

        const edges = this.mesh.getVertexEdges(vertexId);
        for (const edge of edges) {
          // Don't traverse the new edge we just created
          if ((edge.startVertexId === v1Id && edge.endVertexId === v2Id) ||
              (edge.startVertexId === v2Id && edge.endVertexId === v1Id)) {
            continue;
          }

          const neighborId = edge.startVertexId === vertexId ? edge.endVertexId : edge.startVertexId;

          if (neighborId === targetId && path.length >= 2) {
            // Found a loop! Return all vertex IDs including the target
            return [...path, targetId];
          }

          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            queue.push({ vertexId: neighborId, path: [...path, neighborId] });
          }
        }
      }
      return null;
    };

    const loop = findLoop(v2Id, v1Id);
    if (!loop) return;

    // Check if all vertices in the loop are coplanar
    if (loop.length < 3) return;
    if (!this.checkCoplanar(loop)) return;

    // Check that no face already exists with these exact vertices (in any order)
    for (const [, face] of this.mesh.faces) {
      if (face.vertexIds.length === loop.length) {
        const faceSet = new Set(face.vertexIds);
        if (loop.every(v => faceSet.has(v))) return; // Face already exists
      }
    }

    // Create the face
    try {
      this.createFace(loop);
    } catch {
      // Silently ignore face creation errors (e.g., degenerate geometry)
    }
  }

  /**
   * Split any face that is bisected by a path of vertices (e.g., an arc from A to B).
   * If the first and last vertex of the path are both on a face boundary,
   * that face is split into two: one side includes the path, the other side
   * includes the remaining boundary vertices.
   */
  splitFaceWithPath(pathVertexIds: string[]): void {
    if (pathVertexIds.length < 2) return;
    const startId = pathVertexIds[0];
    const endId = pathVertexIds[pathVertexIds.length - 1];

    // Find a face where start and end are on the boundary or on a boundary edge
    for (const [faceId, face] of this.mesh.faces) {
      let verts = [...face.vertexIds];

      // For each path endpoint, if it's not in the vertex list,
      // check if it lies ON one of the face's edges and insert it
      for (const checkId of [startId, endId]) {
        if (verts.includes(checkId)) continue;

        const checkVert = this.mesh.vertices.get(checkId);
        if (!checkVert) continue;

        // Check each edge of the face boundary
        let inserted = false;
        for (let i = 0; i < verts.length && !inserted; i++) {
          const nextI = (i + 1) % verts.length;
          const va = this.mesh.vertices.get(verts[i]);
          const vb = this.mesh.vertices.get(verts[nextI]);
          if (!va || !vb) continue;

          // Check if checkVert is on the edge va→vb (within tolerance)
          const edgeDir = vec3.sub(vb.position, va.position);
          const edgeLen = vec3.length(edgeDir);
          if (edgeLen < 1e-10) continue;

          const toPoint = vec3.sub(checkVert.position, va.position);
          const t = vec3.dot(toPoint, edgeDir) / (edgeLen * edgeLen);

          if (t < -0.01 || t > 1.01) continue; // Not on edge segment

          const closest = vec3.add(va.position, vec3.mul(edgeDir, t));
          const dist = vec3.distance(closest, checkVert.position);

          if (dist < 0.05) { // On this edge
            // Insert the vertex into the face boundary between i and nextI
            verts.splice(i + 1, 0, checkId);

            // Also split the geometric edge
            const existingEdge = this.mesh.findEdgeBetween(verts[i], verts[i + 2]);
            if (existingEdge) {
              // Remove old edge, create two new ones
              this.mesh.removeEdge(existingEdge.id);
              this.mesh.addEdge(verts[i], checkId);
              this.mesh.addEdge(checkId, verts[i + 2]);
            }

            inserted = true;
          }
        }
      }

      // Update the face's vertex list with any inserted vertices
      // (need to update the actual face in the mesh)
      face.vertexIds = verts;

      const idxStart = verts.indexOf(startId);
      const idxEnd = verts.indexOf(endId);
      if (idxStart === -1 || idxEnd === -1) continue;
      if (verts.length < 3) continue;

      // Don't split if start and end are adjacent (the path would just be one edge)
      const n = verts.length;
      const diff = Math.abs(idxStart - idxEnd);
      if (diff === 1 || diff === n - 1) continue;

      // Build two new faces:
      // Face 1: go from start to end clockwise on the boundary
      // Face 2: go from end to start clockwise + path vertices in between
      const lo = Math.min(idxStart, idxEnd);
      const hi = Math.max(idxStart, idxEnd);
      const isStartLo = idxStart <= idxEnd;

      // Boundary side 1: vertices from lo to hi (inclusive)
      const side1: string[] = [];
      for (let i = lo; i <= hi; i++) side1.push(verts[i]);

      // Boundary side 2: vertices from hi to lo (wrapping)
      const side2: string[] = [];
      for (let i = hi; i !== lo; i = (i + 1) % n) side2.push(verts[i]);
      side2.push(verts[lo]);

      // The path interior (excluding start/end which are already on the boundary)
      const pathInterior = pathVertexIds.slice(1, -1);

      // Face A = side1 + path interior going from end to start
      // Face B = side2 + path interior going from start to end
      // We need to figure out which direction the path goes relative to the face boundary
      let faceA: string[];
      let faceB: string[];

      if (isStartLo) {
        // side1 goes lo→hi on boundary, path goes lo→hi through interior
        // Face A = boundary from lo to hi + arc reversed back to lo
        faceA = [...side1, ...pathInterior.slice().reverse()];
        // Face B = arc from lo to hi + boundary from hi back to lo
        faceB = [verts[lo], ...pathInterior, verts[hi]];
        for (let i = (hi + 1) % n; i !== lo; i = (i + 1) % n) faceB.push(verts[i]);
      } else {
        // side1 goes lo→hi on boundary, path goes hi→lo through interior
        faceA = [...side1, ...pathInterior.slice()];
        faceB = [verts[hi], ...pathInterior.slice().reverse(), verts[lo]];
        for (let i = (lo + 1) % n; i !== hi; i = (i + 1) % n) faceB.push(verts[i]);
      }

      // Delete original face
      this.deleteFace(faceId);

      // Create the two new faces
      if (faceA.length >= 3) {
        try { this.createFace(faceA); } catch {}
      }
      if (faceB.length >= 3) {
        try { this.createFace(faceB); } catch {}
      }

      return; // Only split one face per call
    }
  }

  createFace(vertexIds: string[]): IFace {
    if (vertexIds.length < 3) {
      throw new Error('A face requires at least 3 vertices');
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
      if (dist > EPSILON * 1000) return false; // Use relaxed tolerance for coplanarity
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
    if (version !== VERSION) throw new Error(`Unsupported geometry version: ${version}`);

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

      const e: IEdge = { id, startVertexId, endVertexId, soft, smooth, selected, hidden, materialIndex };
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

      const normal: Vec3 = { x: nx, y: ny, z: nz };
      const f: IFace = {
        id, vertexIds, normal,
        plane: { normal: { ...normal }, distance: planeDist },
        materialIndex, backMaterialIndex, selected, hidden, area,
      };
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
