// @archigraph renderer.scene-bridge
// Synchronizes the geometry engine's B-Rep data with Three.js scene objects.

import * as THREE from 'three';
import type { IGeometryEngine, IFace, IEdge, ISceneManager, IMaterialManager } from '../../src/core/interfaces';
import type { WebGLRenderer } from './WebGLRenderer';
import type { SceneManager } from '../data.scene/SceneManager';

export class SceneBridge {
  private engine: IGeometryEngine;
  private sceneManager: SceneManager | null = null;
  private materialManager: IMaterialManager | null = null;
  private webglRenderer: WebGLRenderer;
  private scene: THREE.Scene;
  private overlayScene: THREE.Scene;

  // Maps geometry IDs to their Three.js parent objects (groups or lines)
  private faceGroups = new Map<string, THREE.Group>();
  private edgeLines = new Map<string, THREE.Line>();

  // Materials
  private faceMaterial: THREE.MeshStandardMaterial;
  private backFaceMaterial: THREE.MeshStandardMaterial;
  private edgeMaterial: THREE.LineBasicMaterial;

  // Preview overlays
  private previewGroup: THREE.Group;
  private previewMaterial: THREE.LineDashedMaterial;

  // Texture cache (data URL -> THREE.Texture)
  private textureCache = new Map<string, THREE.Texture>();

  // Snap cursor marker
  private snapMarker: THREE.Group;
  private snapMarkerRing: THREE.Mesh;
  private snapMarkerDot: THREE.Mesh;
  private snapActive = false;

  constructor(engine: IGeometryEngine, webglRenderer: WebGLRenderer) {
    this.engine = engine;
    this.webglRenderer = webglRenderer;
    this.scene = webglRenderer.getScene();
    this.overlayScene = webglRenderer.getOverlayScene();

    this.faceMaterial = new THREE.MeshStandardMaterial({
      color: 0xd9d9d9,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    // Back-face material no longer used — DoubleSide on faceMaterial handles both sides.
    // Kept for API compatibility but not added to scene.
    this.backFaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x8888cc,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.BackSide,
    });

    this.edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x222222,
      linewidth: 2,
    });

    this.previewMaterial = new THREE.LineDashedMaterial({
      color: 0x0066ff,
      linewidth: 2,
      dashSize: 0.3,
      gapSize: 0.15,
    });

    this.previewGroup = new THREE.Group();
    this.previewGroup.name = 'preview';
    this.previewGroup.renderOrder = 999;
    // Put preview on layer 1 so raycaster (layer 0 only) ignores it
    this.setNonRaycastable(this.previewGroup);
    this.scene.add(this.previewGroup);

    // Create snap cursor marker — a green ring + dot that appears at snap points
    this.snapMarker = new THREE.Group();
    this.snapMarker.name = 'snap-marker';
    this.snapMarker.visible = false;
    this.snapMarker.renderOrder = 1000;

    // Green dot at center
    const dotGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x00cc44, depthTest: false });
    this.snapMarkerDot = new THREE.Mesh(dotGeo, dotMat);
    this.snapMarker.add(this.snapMarkerDot);

    // Green ring around dot
    const ringGeo = new THREE.RingGeometry(0.12, 0.16, 16);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00cc44, side: THREE.DoubleSide, depthTest: false });
    this.snapMarkerRing = new THREE.Mesh(ringGeo, ringMat);
    this.snapMarker.add(this.snapMarkerRing);

    // Snap marker is non-raycastable
    this.setNonRaycastable(this.snapMarker);
    this.scene.add(this.snapMarker);
  }

  setSceneManager(sm: SceneManager): void {
    this.sceneManager = sm;
  }

  setMaterialManager(mm: IMaterialManager): void {
    this.materialManager = mm;
  }

  private getTexture(dataUrl: string): THREE.Texture {
    let tex = this.textureCache.get(dataUrl);
    if (tex) return tex;
    tex = new THREE.TextureLoader().load(dataUrl);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set(dataUrl, tex);
    return tex;
  }

  private applyMaterialDef(mat: THREE.MeshStandardMaterial, matDef: { color: { r: number; g: number; b: number }; opacity?: number; roughness?: number; metalness?: number; albedoMap?: string }): void {
    mat.opacity = matDef.opacity ?? 1;
    mat.transparent = mat.opacity < 1;
    mat.roughness = matDef.roughness ?? 0.7;
    mat.metalness = matDef.metalness ?? 0;
    if (matDef.albedoMap) {
      // When using a texture map, set color to white so Three.js doesn't
      // multiply/darken the texture by the material color.
      mat.color.setRGB(1, 1, 1);
      mat.map = this.getTexture(matDef.albedoMap);
      mat.needsUpdate = true;
    } else {
      mat.color.setRGB(matDef.color.r, matDef.color.g, matDef.color.b);
      if (mat.map) {
        mat.map = null;
        mat.needsUpdate = true;
      }
    }
  }

  /** Full sync: rebuild Three.js scene from geometry engine state. */
  sync(): void {
    const mesh = this.engine.getMesh();

    const liveFaceIds = new Set<string>();
    const liveEdgeIds = new Set<string>();

    // Sync faces (auto-assign to active layer, respect layer visibility)
    mesh.faces.forEach((face, id) => {
      liveFaceIds.add(id);
      if (this.sceneManager) {
        // Auto-assign new geometry to active layer
        if (!this.sceneManager.geometryLayerMap.has(id)) {
          this.sceneManager.geometryLayerMap.set(id, this.sceneManager.activeLayerId);
        }
      }
      const visible = this.sceneManager ? this.sceneManager.isEntityVisible(id) : true;
      this.syncFace(id, face);
      const group = this.faceGroups.get(id);
      if (group) group.visible = visible;
    });

    // Sync edges (auto-assign to active layer, respect layer visibility)
    mesh.edges.forEach((edge, id) => {
      liveEdgeIds.add(id);
      if (this.sceneManager) {
        if (!this.sceneManager.geometryLayerMap.has(id)) {
          this.sceneManager.geometryLayerMap.set(id, this.sceneManager.activeLayerId);
        }
      }
      const visible = this.sceneManager ? this.sceneManager.isEntityVisible(id) : true;
      this.syncEdge(id, edge);
      const line = this.edgeLines.get(id);
      if (line) line.visible = visible;
    });

    // Remove faces that no longer exist
    for (const [id, group] of this.faceGroups) {
      if (!liveFaceIds.has(id)) {
        this.scene.remove(group);
        group.traverse(child => {
          if (child instanceof THREE.Mesh) child.geometry.dispose();
        });
        this.webglRenderer.unregisterEntityObject(id);
        this.faceGroups.delete(id);
      }
    }

    // Remove edges that no longer exist
    for (const [id, line] of this.edgeLines) {
      if (!liveEdgeIds.has(id)) {
        this.overlayScene.remove(line);
        line.geometry.dispose();
        this.webglRenderer.unregisterEntityObject(id);
        this.edgeLines.delete(id);
      }
    }

    // Render component bounding boxes
    this.syncComponentBoxes(mesh);
  }

  private componentBoxes = new Map<string, THREE.LineSegments>();

  private syncComponentBoxes(mesh: any): void {
    if (!this.sceneManager) return;

    const liveCompIds = new Set<string>();

    for (const [compId, comp] of this.sceneManager.components) {
      liveCompIds.add(compId);

      // Compute bounding box of all component vertices
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const seen = new Set<string>();

      for (const eid of comp.entityIds) {
        const face = mesh.faces.get(eid);
        if (face) {
          for (const vid of face.vertexIds) {
            if (seen.has(vid)) continue;
            seen.add(vid);
            const v = mesh.vertices.get(vid);
            if (!v) continue;
            minX = Math.min(minX, v.position.x); maxX = Math.max(maxX, v.position.x);
            minY = Math.min(minY, v.position.y); maxY = Math.max(maxY, v.position.y);
            minZ = Math.min(minZ, v.position.z); maxZ = Math.max(maxZ, v.position.z);
          }
        }
        const edge = mesh.edges.get(eid);
        if (edge) {
          for (const vid of [edge.startVertexId, edge.endVertexId]) {
            if (seen.has(vid)) continue;
            seen.add(vid);
            const v = mesh.vertices.get(vid);
            if (!v) continue;
            minX = Math.min(minX, v.position.x); maxX = Math.max(maxX, v.position.x);
            minY = Math.min(minY, v.position.y); maxY = Math.max(maxY, v.position.y);
            minZ = Math.min(minZ, v.position.z); maxZ = Math.max(maxZ, v.position.z);
          }
        }
      }

      if (!isFinite(minX)) continue;

      // Pad slightly
      const pad = 0.05;
      minX -= pad; minY -= pad; minZ -= pad;
      maxX += pad; maxY += pad; maxZ += pad;

      const boxGeo = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
      const edges = new THREE.EdgesGeometry(boxGeo);

      if (this.componentBoxes.has(compId)) {
        const existing = this.componentBoxes.get(compId)!;
        existing.geometry.dispose();
        existing.geometry = edges;
        existing.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      } else {
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
          color: 0x9c27b0, linewidth: 1, depthTest: false,
        }));
        line.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        line.raycast = () => {};
        this.overlayScene.add(line);
        this.componentBoxes.set(compId, line);
      }

      boxGeo.dispose();
    }

    // Remove boxes for deleted components
    for (const [id, line] of this.componentBoxes) {
      if (!liveCompIds.has(id)) {
        this.overlayScene.remove(line);
        line.geometry.dispose();
        this.componentBoxes.delete(id);
      }
    }
  }

  private syncFace(id: string, face: IFace): void {
    const verts = this.engine.getFaceVertices(id);
    if (verts.length < 3) return;

    // Nudge vertex positions slightly along face normal to prevent z-fighting
    // between coplanar adjacent faces. Applied to buffer data only — geometry
    // engine keeps true coplanar positions. Nudge is per-face-id so each face
    // gets a unique micro-offset.
    const n = face.normal;
    const nudge = this.faceNudge(id);
    const nx = n.x * nudge;
    const ny = n.y * nudge;
    const nz = n.z * nudge;

    // Compute UV basis from the face's own geometry so textures stick to the
    // face when it moves or rotates. U axis = first edge direction, V axis =
    // perpendicular within the face plane. Origin = first vertex.
    const p0 = verts[0].position;
    const p1 = verts[1].position;
    let ux = p1.x - p0.x, uy = p1.y - p0.y, uz = p1.z - p0.z;
    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= uLen; uy /= uLen; uz /= uLen;
    // V = normalize(normal × U) — perpendicular to U within the face plane
    let vx = n.y * uz - n.z * uy;
    let vy = n.z * ux - n.x * uz;
    let vz = n.x * uy - n.y * ux;
    const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    vx /= vLen; vy /= vLen; vz /= vLen;
    const uvScale = 1.0; // 1 texture repeat per meter

    // Build triangle geometry (fan triangulation)
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    for (let i = 1; i < verts.length - 1; i++) {
      const tri = [verts[0], verts[i], verts[i + 1]];
      for (const v of tri) {
        positions.push(v.position.x + nx, v.position.y + ny, v.position.z + nz);
        normals.push(n.x, n.y, n.z);
        // UV relative to face origin (first vertex)
        const dx = v.position.x - p0.x;
        const dy = v.position.y - p0.y;
        const dz = v.position.z - p0.z;
        uvs.push(
          (dx * ux + dy * uy + dz * uz) * uvScale,
          (dx * vx + dy * vy + dz * vz) * uvScale,
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    // Resolve material from MaterialManager
    const matDef = this.materialManager?.getFaceMaterial(id);

    if (this.faceGroups.has(id)) {
      // Update: replace geometry on existing mesh, sync material
      const group = this.faceGroups.get(id)!;
      group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          child.geometry = geometry;
          if (matDef) this.applyMaterialDef(child.material as THREE.MeshStandardMaterial, matDef);
        }
      });
    } else {
      // Create single DoubleSide mesh (no separate back mesh)
      const group = new THREE.Group();
      group.name = `face-${id}`;
      group.userData.entityId = id;
      group.userData.entityType = 'face';

      const meshMat = this.faceMaterial.clone();
      if (matDef) this.applyMaterialDef(meshMat, matDef);
      const mesh = new THREE.Mesh(geometry, meshMat);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData.entityId = id;
      mesh.userData.entityType = 'face';

      group.add(mesh);

      this.scene.add(group);
      this.faceGroups.set(id, group);
      this.webglRenderer.registerEntityObject(id, mesh);
    }
  }

  private syncEdge(id: string, edge: IEdge): void {
    const v1 = this.engine.getVertex(edge.startVertexId);
    const v2 = this.engine.getVertex(edge.endVertexId);
    if (!v1 || !v2) return;

    const points = [
      new THREE.Vector3(v1.position.x, v1.position.y, v1.position.z),
      new THREE.Vector3(v2.position.x, v2.position.y, v2.position.z),
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    if (this.edgeLines.has(id)) {
      const existing = this.edgeLines.get(id)!;
      existing.geometry.dispose();
      existing.geometry = geometry;
    } else {
      const line = new THREE.Line(geometry, this.edgeMaterial); // Shared material, never swapped
      line.userData.entityId = id;
      line.userData.entityType = 'edge';
      this.overlayScene.add(line); // Overlay scene renders AFTER main scene (separate pass)
      this.edgeLines.set(id, line);
      this.webglRenderer.registerEntityObject(id, line);
    }
  }

  // ── Preview rendering ──────────────────────────────────────────

  /** Show rubber-band line from a point to cursor. */
  setRubberBand(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    this.clearRubberBand();
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    const line = new THREE.Line(geometry, this.previewMaterial);
    line.computeLineDistances();
    line.name = 'rubber-band';
    line.raycast = () => {}; // Non-raycastable
    this.previewGroup.add(line);
  }

  /** Show preview polygon outline (rectangle, circle, etc.). */
  setPreviewRect(corners: Array<{ x: number; y: number; z: number }>): void {
    this.clearPreviewEdges();
    if (corners.length < 2) return;

    const points = corners.map(c => new THREE.Vector3(c.x, c.y, c.z));
    points.push(points[0].clone()); // Close the loop

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, this.previewMaterial);
    line.computeLineDistances();
    line.name = 'preview-polygon';
    line.raycast = () => {}; // Non-raycastable
    this.previewGroup.add(line);
  }

  clearRubberBand(): void {
    const rb = this.previewGroup.getObjectByName('rubber-band');
    if (rb) {
      this.previewGroup.remove(rb);
      if (rb instanceof THREE.Line) rb.geometry.dispose();
    }
  }

  clearPreviewEdges(): void {
    const children = [...this.previewGroup.children];
    for (const child of children) {
      this.previewGroup.remove(child);
      if (child instanceof THREE.Line) child.geometry.dispose();
    }
  }

  // ── Snap cursor ─────────────────────────────────────────────────

  /**
   * Find the nearest vertex endpoint within snapRadius screen pixels.
   * Returns the snapped world point, or the original worldPoint if no snap.
   * Also positions the snap marker in the 3D scene.
   */
  findSnapPoint(
    screenX: number, screenY: number,
    worldPoint: { x: number; y: number; z: number } | null,
    viewportWidth: number, viewportHeight: number,
    camera: any, // ICameraController
    snapRadiusPx: number = 15,
  ): { x: number; y: number; z: number } | null {
    const mesh = this.engine.getMesh();
    if (mesh.vertices.size === 0) {
      this.hideSnapMarker();
      return worldPoint;
    }

    let bestDist = Infinity;
    let bestPoint: { x: number; y: number; z: number } | null = null;

    // Check all vertex positions — project to screen and compare distance
    mesh.vertices.forEach((vertex) => {
      const screenPos = camera.worldToScreen(vertex.position, viewportWidth, viewportHeight);
      const dx = screenPos.x - screenX;
      const dy = screenPos.y - screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < snapRadiusPx && dist < bestDist) {
        bestDist = dist;
        bestPoint = { ...vertex.position };
      }
    });

    // Also check edge midpoints
    mesh.edges.forEach((edge) => {
      const v1 = mesh.vertices.get(edge.startVertexId);
      const v2 = mesh.vertices.get(edge.endVertexId);
      if (!v1 || !v2) return;

      const mid = {
        x: (v1.position.x + v2.position.x) / 2,
        y: (v1.position.y + v2.position.y) / 2,
        z: (v1.position.z + v2.position.z) / 2,
      };
      const screenPos = camera.worldToScreen(mid, viewportWidth, viewportHeight);
      const dx = screenPos.x - screenX;
      const dy = screenPos.y - screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < snapRadiusPx && dist < bestDist) {
        bestDist = dist;
        bestPoint = mid;
      }
    });

    // Check edge-edge intersection points
    const edgeArray = Array.from(mesh.edges.values());
    for (let i = 0; i < edgeArray.length; i++) {
      const e1 = edgeArray[i];
      const a1 = mesh.vertices.get(e1.startVertexId);
      const a2 = mesh.vertices.get(e1.endVertexId);
      if (!a1 || !a2) continue;

      for (let j = i + 1; j < edgeArray.length; j++) {
        const e2 = edgeArray[j];
        const b1 = mesh.vertices.get(e2.startVertexId);
        const b2 = mesh.vertices.get(e2.endVertexId);
        if (!b1 || !b2) continue;

        // Skip if edges share a vertex (they meet at an endpoint, already snappable)
        if (e1.startVertexId === e2.startVertexId || e1.startVertexId === e2.endVertexId ||
            e1.endVertexId === e2.startVertexId || e1.endVertexId === e2.endVertexId) continue;

        // Find closest point between two line segments
        const intersection = this.edgeEdgeIntersection(
          a1.position, a2.position, b1.position, b2.position
        );
        if (!intersection) continue;

        const screenPos = camera.worldToScreen(intersection, viewportWidth, viewportHeight);
        const dx = screenPos.x - screenX;
        const dy = screenPos.y - screenY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < snapRadiusPx && dist < bestDist) {
          bestDist = dist;
          bestPoint = intersection;
        }
      }
    }

    if (bestPoint) {
      this.showSnapMarker(bestPoint, camera);
      return bestPoint;
    }

    // No snap — show marker at cursor world position if available
    if (worldPoint) {
      this.showCursorMarker(worldPoint, camera);
    } else {
      this.hideSnapMarker();
    }
    return worldPoint;
  }

  /** Scale snap marker so it appears constant size on screen regardless of zoom. */
  private scaleMarkerToCamera(point: { x: number; y: number; z: number }, camera: any): void {
    const camPos = camera.position || { x: 0, y: 10, z: 10 };
    const dx = point.x - camPos.x;
    const dy = point.y - camPos.y;
    const dz = point.z - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Scale factor: keep marker visually prominent at any distance
    const s = Math.max(dist * 0.04, 0.04);
    this.snapMarker.scale.set(s, s, s);
  }

  /** Show the green snap marker at a snapped endpoint. */
  private showSnapMarker(point: { x: number; y: number; z: number }, camera: any): void {
    this.snapMarker.position.set(point.x, point.y, point.z);
    this.snapMarker.visible = true;
    this.snapActive = true;

    const camPos = camera.position;
    this.snapMarkerRing.lookAt(camPos.x, camPos.y, camPos.z);
    this.scaleMarkerToCamera(point, camera);

    (this.snapMarkerDot.material as THREE.MeshBasicMaterial).color.setHex(0x00cc44);
    (this.snapMarkerRing.material as THREE.MeshBasicMaterial).color.setHex(0x00cc44);
    this.snapMarkerRing.visible = true;
  }

  /** Show a small blue marker at cursor position (no snap). */
  private showCursorMarker(point: { x: number; y: number; z: number }, camera: any): void {
    this.snapMarker.position.set(point.x, point.y, point.z);
    this.snapMarker.visible = true;
    this.snapActive = false;

    const camPos = camera.position;
    this.snapMarkerRing.lookAt(camPos.x, camPos.y, camPos.z);
    this.scaleMarkerToCamera(point, camera);

    (this.snapMarkerDot.material as THREE.MeshBasicMaterial).color.setHex(0x3388ff);
    (this.snapMarkerRing.material as THREE.MeshBasicMaterial).color.setHex(0x3388ff);
    this.snapMarkerRing.visible = false;
  }

  hideSnapMarker(): void {
    this.snapMarker.visible = false;
    this.snapActive = false;
  }

  get isSnapped(): boolean {
    return this.snapActive;
  }

  /**
   * Find the intersection point of two 3D line segments, if they intersect
   * or nearly intersect (within tolerance). Returns null if no intersection.
   */
  /**
   * Compute a tiny deterministic normal-offset for a face to prevent
   * z-fighting between coplanar adjacent faces. Each face id hashes
   * to a unique micro-offset in the range [0.0001, 0.001].
   */
  private faceNudge(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    // Map to [0.0001 .. 0.001] — invisible but enough to break depth ties
    return 0.0001 + (Math.abs(hash) % 900) * 0.000001;
  }

  private edgeEdgeIntersection(
    a1: { x: number; y: number; z: number }, a2: { x: number; y: number; z: number },
    b1: { x: number; y: number; z: number }, b2: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } | null {
    const TOLERANCE = 0.05;

    // Direction vectors
    const da = { x: a2.x - a1.x, y: a2.y - a1.y, z: a2.z - a1.z };
    const db = { x: b2.x - b1.x, y: b2.y - b1.y, z: b2.z - b1.z };
    const w = { x: a1.x - b1.x, y: a1.y - b1.y, z: a1.z - b1.z };

    const a = da.x * da.x + da.y * da.y + da.z * da.z;
    const b = da.x * db.x + da.y * db.y + da.z * db.z;
    const c = db.x * db.x + db.y * db.y + db.z * db.z;
    const d = da.x * w.x + da.y * w.y + da.z * w.z;
    const e = db.x * w.x + db.y * w.y + db.z * w.z;

    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-10) return null; // Parallel

    const s = (b * e - c * d) / denom;
    const t = (a * e - b * d) / denom;

    // Must be within segment bounds (0 to 1), with small tolerance
    if (s < -0.01 || s > 1.01 || t < -0.01 || t > 1.01) return null;

    // Points on each line closest to the other
    const pa = { x: a1.x + s * da.x, y: a1.y + s * da.y, z: a1.z + s * da.z };
    const pb = { x: b1.x + t * db.x, y: b1.y + t * db.y, z: b1.z + t * db.z };

    // Distance between closest points
    const dist = Math.sqrt(
      (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2 + (pa.z - pb.z) ** 2
    );

    if (dist > TOLERANCE) return null; // Too far apart

    // Return midpoint of the two closest points
    return {
      x: (pa.x + pb.x) / 2,
      y: (pa.y + pb.y) / 2,
      z: (pa.z + pb.z) / 2,
    };
  }

  /** Make an object and all its current children invisible to the raycaster. */
  private setNonRaycastable(obj: THREE.Object3D): void {
    obj.raycast = () => {}; // No-op raycast
    obj.traverse(child => {
      child.raycast = () => {};
    });
  }

  dispose(): void {
    this.clearPreviewEdges();
    // Remove all face groups and edge lines
    for (const [, group] of this.faceGroups) {
      this.scene.remove(group);
      group.traverse(child => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
    for (const [, line] of this.edgeLines) {
      this.overlayScene.remove(line);
      line.geometry.dispose();
    }
    this.faceGroups.clear();
    this.edgeLines.clear();
    this.faceMaterial.dispose();
    this.backFaceMaterial.dispose();
    this.edgeMaterial.dispose();
    this.previewMaterial.dispose();
  }
}
