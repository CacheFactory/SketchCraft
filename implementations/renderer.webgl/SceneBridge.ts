// @archigraph renderer.scene-bridge
// Synchronizes the geometry engine's B-Rep data with Three.js scene objects.

import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';
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

  // Dirty tracking: cache vertex position hashes to skip unchanged faces/edges
  private lastVertexPositions = new Map<string, string>();

  // Batched mode: large model imported as single merged mesh.
  // sync() will only process NEW geometry added after the batch.
  private _batchedMode = false;
  private _batchedFaceIds = new Set<string>();
  private _batchedEdgeIds = new Set<string>();
  // GPU picking for batched faces: pick mesh + ID-to-face mapping
  private _batchedPickMesh: THREE.Mesh | null = null;
  private _batchedPickIdToFace = new Map<number, string>();
  // Face ID → triangle vertex range in the batched position buffer (for highlighting)
  private _batchedFaceTriRange = new Map<string, { start: number; count: number }>();
  private _batchedPositionBuffer: Float32Array | null = null;

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

  /**
   * Batched sync for large imports: merges ALL faces into a single BufferGeometry
   * and ALL edges into a single LineSegments, avoiding per-face overhead.
   * Returns the number of faces synced.
   */
  syncBatched(): number {
    this._batchedMode = true;
    this._batchedFaceIds.clear();
    this._batchedEdgeIds.clear();
    const mesh = this.engine.getMesh();

    // Record all current face/edge IDs as batched (sync() will skip these)
    mesh.faces.forEach((_, id) => this._batchedFaceIds.add(id));
    mesh.edges.forEach((_, id) => this._batchedEdgeIds.add(id));
    const faceCount = mesh.faces.size;
    const edgeCount = mesh.edges.size;

    console.log(`[syncBatched] Starting: ${faceCount} faces, ${edgeCount} edges`);

    // Remove any existing individual face/edge objects first
    for (const [id, group] of this.faceGroups) {
      this.scene.remove(group);
      group.traverse(child => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      this.webglRenderer.unregisterEntityObject(id);
    }
    this.faceGroups.clear();

    for (const [id, line] of this.edgeLines) {
      this.overlayScene.remove(line);
      line.geometry.dispose();
      this.webglRenderer.unregisterEntityObject(id);
    }
    this.edgeLines.clear();

    // Remove previous batched mesh if any
    const oldBatch = this.scene.getObjectByName('batched-faces');
    if (oldBatch) {
      this.scene.remove(oldBatch);
      oldBatch.traverse(child => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
    const oldEdgeBatch = this.overlayScene.getObjectByName('batched-edges');
    if (oldEdgeBatch) {
      this.overlayScene.remove(oldEdgeBatch);
      if (oldEdgeBatch instanceof THREE.LineSegments) oldEdgeBatch.geometry.dispose();
    }

    // --- Batch all faces into one merged BufferGeometry ---
    // First pass: earcut each face to get accurate triangle count
    const faceTriData: Array<{ indices: number[]; verts: Array<{ position: { x: number; y: number; z: number } }>; normal: { x: number; y: number; z: number }; id: string }> = [];
    let totalTriangles = 0;

    mesh.faces.forEach((face, id) => {
      const verts = this.engine.getFaceVertices(id);
      if (verts.length < 3) return;

      const n = face.normal;
      // Project to 2D for earcut
      const p0 = verts[0].position;
      const p1 = verts[1].position;
      let eux = p1.x - p0.x, euy = p1.y - p0.y, euz = p1.z - p0.z;
      const euLen = Math.sqrt(eux * eux + euy * euy + euz * euz) || 1;
      eux /= euLen; euy /= euLen; euz /= euLen;
      let evx = n.y * euz - n.z * euy, evy = n.z * eux - n.x * euz, evz = n.x * euy - n.y * eux;
      const evLen = Math.sqrt(evx * evx + evy * evy + evz * evz) || 1;
      evx /= evLen; evy /= evLen; evz /= evLen;

      const flat2d: number[] = [];
      for (const v of verts) {
        const dx = v.position.x - p0.x, dy = v.position.y - p0.y, dz = v.position.z - p0.z;
        flat2d.push(dx * eux + dy * euy + dz * euz, dx * evx + dy * evy + dz * evz);
      }
      let indices = Earcut.triangulate(flat2d, undefined, 2);
      if (indices.length === 0) {
        indices = [];
        for (let i = 1; i < verts.length - 1; i++) indices.push(0, i, i + 1);
      }
      totalTriangles += indices.length / 3;
      faceTriData.push({ indices, verts, normal: n, id });
    });

    const posArr = new Float32Array(totalTriangles * 3 * 3);
    const normArr = new Float32Array(totalTriangles * 3 * 3);
    const pickColorArr = new Float32Array(totalTriangles * 3 * 3); // RGB pick colors per vertex
    let triOffset = 0;
    this._batchedPickIdToFace.clear();
    this._batchedFaceTriRange.clear();
    let pickId = 1; // 0 = background/no entity

    for (const { indices, verts, normal: n, id } of faceTriData) {
      // Encode this face's pick ID as RGB
      const pr = ((pickId >> 16) & 0xff) / 255;
      const pg = ((pickId >> 8) & 0xff) / 255;
      const pb = (pickId & 0xff) / 255;
      this._batchedPickIdToFace.set(pickId, id);
      pickId++;

      // Record triangle range for this face (vertex offset, vertex count)
      const faceVertStart = triOffset;
      const faceVertCount = indices.length;
      this._batchedFaceTriRange.set(id, { start: faceVertStart, count: faceVertCount });

      for (let i = 0; i < indices.length; i++) {
        const v = verts[indices[i]];
        const base = triOffset * 3;
        posArr[base] = v.position.x;
        posArr[base + 1] = v.position.y;
        posArr[base + 2] = v.position.z;
        normArr[base] = n.x;
        normArr[base + 1] = n.y;
        normArr[base + 2] = n.z;
        pickColorArr[base] = pr;
        pickColorArr[base + 1] = pg;
        pickColorArr[base + 2] = pb;
        triOffset++;
      }

      // Auto-assign to active layer
      if (this.sceneManager && !this.sceneManager.geometryLayerMap.has(id)) {
        this.sceneManager.geometryLayerMap.set(id, this.sceneManager.activeLayerId);
      }
    }

    console.log(`[syncBatched] Built ${totalTriangles} triangles`);

    this._batchedPositionBuffer = posArr;

    const batchGeo = new THREE.BufferGeometry();
    batchGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    batchGeo.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    batchGeo.computeBoundingSphere();
    batchGeo.computeBoundingBox();

    console.log(`[syncBatched] Geometry buffer: ${posArr.length} floats, boundingSphere radius: ${batchGeo.boundingSphere?.radius.toFixed(1)}, bbox: ${JSON.stringify(batchGeo.boundingBox?.min)}-${JSON.stringify(batchGeo.boundingBox?.max)}`);

    const batchMat = this.faceMaterial.clone();
    const batchMesh = new THREE.Mesh(batchGeo, batchMat);
    batchMesh.name = 'batched-faces';
    batchMesh.castShadow = false;  // Shadows disabled for large batched meshes (doubles GPU work)
    batchMesh.receiveShadow = false;
    batchMesh.frustumCulled = false; // Large meshes can be incorrectly culled
    this.scene.add(batchMesh);

    // --- Build GPU pick mesh for batched faces (vertex colors encode face IDs) ---
    const pickGeo = new THREE.BufferGeometry();
    pickGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    pickGeo.setAttribute('color', new THREE.BufferAttribute(pickColorArr, 3));
    // Use a raw shader material to bypass Three.js color space conversions entirely
    const pickMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          gl_FragColor = vec4(vColor, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });
    pickMat.toneMapped = false;
    if (this._batchedPickMesh) {
      this._batchedPickMesh.geometry.dispose();
      (this._batchedPickMesh.material as THREE.Material).dispose();
    }
    this._batchedPickMesh = new THREE.Mesh(pickGeo, pickMat);
    this._batchedPickMesh.name = 'batched-pick';
    this._batchedPickMesh.frustumCulled = false;
    // Register with renderer so pick system knows about it
    this.webglRenderer.setBatchedPickMesh(this._batchedPickMesh, this._batchedPickIdToFace);
    this.webglRenderer.setBatchedFaceHighlightFn((faceId: string) => this.getBatchedFaceHighlightGeometry(faceId));

    console.log(`[syncBatched] GPU pick mesh built: ${this._batchedPickIdToFace.size} face IDs encoded`);

    // --- Batch edges into LineSegments (skip if too many — GPU can crash on huge draw calls) ---
    const MAX_BATCHED_EDGES = 200000; // ~400K vertices max in one draw call
    let edgeOffset = 0;

    if (edgeCount <= MAX_BATCHED_EDGES) {
      const edgePositions = new Float32Array(edgeCount * 2 * 3);

      mesh.edges.forEach((edge, id) => {
        const v1 = this.engine.getVertex(edge.startVertexId);
        const v2 = this.engine.getVertex(edge.endVertexId);
        if (!v1 || !v2) return;

        const base = edgeOffset * 3;
        edgePositions[base] = v1.position.x;
        edgePositions[base + 1] = v1.position.y;
        edgePositions[base + 2] = v1.position.z;
        edgePositions[base + 3] = v2.position.x;
        edgePositions[base + 4] = v2.position.y;
        edgePositions[base + 5] = v2.position.z;
        edgeOffset += 2;

        if (this.sceneManager && !this.sceneManager.geometryLayerMap.has(id)) {
          this.sceneManager.geometryLayerMap.set(id, this.sceneManager.activeLayerId);
        }
      });

      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePositions.subarray(0, edgeOffset * 3), 3));
      const edgeBatch = new THREE.LineSegments(edgeGeo, this.edgeMaterial);
      edgeBatch.name = 'batched-edges';
      edgeBatch.frustumCulled = false;
      edgeBatch.raycast = () => {}; // Disable raycast on batched edges (too expensive)
      this.overlayScene.add(edgeBatch);
    } else {
      console.log(`[syncBatched] Skipping ${edgeCount} edges (exceeds ${MAX_BATCHED_EDGES} limit — faces-only mode)`);
    }

    console.log(`[syncBatched] Done: ${totalTriangles} triangles, ${edgeOffset / 2} edges rendered`);
    return faceCount;
  }

  /** Create a temporary highlight mesh for a batched face (for selection/pre-selection). */
  getBatchedFaceHighlightGeometry(faceId: string): THREE.BufferGeometry | null {
    const range = this._batchedFaceTriRange.get(faceId);
    if (!range || !this._batchedPositionBuffer) return null;

    const { start, count } = range;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
      positions[i] = this._batchedPositionBuffer[start * 3 + i];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /** Check if a face ID is part of the batched mesh. */
  isBatchedFace(faceId: string): boolean {
    return this._batchedFaceIds.has(faceId);
  }

  /** Full sync: rebuild Three.js scene from geometry engine state.
   *  @param force - If true, skip dirty tracking and rebuild everything (used after undo/redo).
   */
  sync(force?: boolean): void {
    const t0 = performance.now();
    const mesh = this.engine.getMesh();

    // In batched mode, only process NEW faces/edges (not part of original batch)
    if (!this._batchedMode) {
      // Remove any leftover batched geometry from a previous syncBatched() call
      const oldBatch = this.scene.getObjectByName('batched-faces');
      if (oldBatch) {
        this.scene.remove(oldBatch);
        oldBatch.traverse(child => {
          if (child instanceof THREE.Mesh) child.geometry.dispose();
        });
      }
      const oldEdgeBatch = this.overlayScene.getObjectByName('batched-edges');
      if (oldEdgeBatch) {
        this.overlayScene.remove(oldEdgeBatch);
        if (oldEdgeBatch instanceof THREE.LineSegments) oldEdgeBatch.geometry.dispose();
      }
    }

    const liveFaceIds = new Set<string>();
    const liveEdgeIds = new Set<string>();

    // Build vertex position snapshot only for non-batched vertices (skip batched to save time)
    const currentVertexPositions = new Map<string, string>();
    if (this._batchedMode) {
      // Only snapshot vertices that belong to new (non-batched) geometry
      const newVertexIds = new Set<string>();
      mesh.faces.forEach((face, id) => {
        if (!this._batchedFaceIds.has(id)) {
          for (const vid of face.vertexIds) newVertexIds.add(vid);
        }
      });
      mesh.edges.forEach((edge, id) => {
        if (!this._batchedEdgeIds.has(id)) {
          newVertexIds.add(edge.startVertexId);
          newVertexIds.add(edge.endVertexId);
        }
      });
      for (const vid of newVertexIds) {
        const v = mesh.vertices.get(vid);
        if (v) currentVertexPositions.set(vid, `${v.position.x.toFixed(6)},${v.position.y.toFixed(6)},${v.position.z.toFixed(6)}`);
      }
    } else {
      mesh.vertices.forEach((v, id) => {
        currentVertexPositions.set(id, `${v.position.x.toFixed(6)},${v.position.y.toFixed(6)},${v.position.z.toFixed(6)}`);
      });
    }

    // Sync faces (auto-assign to active layer, respect layer visibility)
    mesh.faces.forEach((face, id) => {
      // Skip batched faces — they're already in the merged mesh
      if (this._batchedMode && this._batchedFaceIds.has(id)) return;
      liveFaceIds.add(id);
      if (this.sceneManager) {
        // Auto-assign new geometry to active layer
        if (!this.sceneManager.geometryLayerMap.has(id)) {
          this.sceneManager.geometryLayerMap.set(id, this.sceneManager.activeLayerId);
        }
      }
      const visible = this.sceneManager ? this.sceneManager.isEntityVisible(id) : true;

      // Skip re-triangulation if face already exists and its vertices haven't moved
      if (!force) {
        const existing = this.faceGroups.get(id);
        if (existing) {
          let dirty = false;
          for (const vid of face.vertexIds) {
            if (currentVertexPositions.get(vid) !== this.lastVertexPositions.get(vid)) {
              dirty = true;
              break;
            }
          }
          if (!dirty) {
            existing.visible = visible;
            return; // Skip — geometry unchanged
          }
        }
      }

      this.syncFace(id, face);
      const group = this.faceGroups.get(id);
      if (group) group.visible = visible;
    });

    // Sync edges (auto-assign to active layer, respect layer visibility)
    mesh.edges.forEach((edge, id) => {
      // Skip batched edges
      if (this._batchedMode && this._batchedEdgeIds.has(id)) return;
      liveEdgeIds.add(id);
      if (this.sceneManager) {
        if (!this.sceneManager.geometryLayerMap.has(id)) {
          this.sceneManager.geometryLayerMap.set(id, this.sceneManager.activeLayerId);
        }
      }
      const visible = this.sceneManager ? this.sceneManager.isEntityVisible(id) : true;

      // Skip edge update if both vertices unchanged and edge already exists
      if (!force && this.edgeLines.has(id)) {
        const v1Hash = currentVertexPositions.get(edge.startVertexId);
        const v2Hash = currentVertexPositions.get(edge.endVertexId);
        if (v1Hash === this.lastVertexPositions.get(edge.startVertexId) &&
            v2Hash === this.lastVertexPositions.get(edge.endVertexId)) {
          const line = this.edgeLines.get(id)!;
          line.visible = visible;
          return; // Skip — unchanged
        }
      }

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

    // Update vertex position cache for next sync's dirty detection
    this.lastVertexPositions = currentVertexPositions;

    // Render component bounding boxes
    this.syncComponentBoxes(mesh);
    console.log(`[SceneBridge.sync] ${(performance.now() - t0).toFixed(1)}ms, faces: ${mesh.faces.size}, edges: ${mesh.edges.size}, force: ${!!force}`);
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

    // Triangulate using ear-clipping (handles non-convex polygons like text)
    // Project 3D vertices to 2D using the face's UV basis
    const flat2d: number[] = [];
    for (const v of verts) {
      const dx = v.position.x - p0.x;
      const dy = v.position.y - p0.y;
      const dz = v.position.z - p0.z;
      flat2d.push(dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz);
    }
    const holeIndices = face.holeStartIndices && face.holeStartIndices.length > 0
      ? face.holeStartIndices : undefined;
    let triIndices = Earcut.triangulate(flat2d, holeIndices, 2);

    // Fallback to fan triangulation if earcut fails
    if (triIndices.length === 0) {
      triIndices = [];
      for (let i = 1; i < verts.length - 1; i++) {
        triIndices.push(0, i, i + 1);
      }
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    for (let i = 0; i < triIndices.length; i++) {
      const v = verts[triIndices[i]];
      positions.push(v.position.x + nx, v.position.y + ny, v.position.z + nz);
      normals.push(n.x, n.y, n.z);
      const dx = v.position.x - p0.x;
      const dy = v.position.y - p0.y;
      const dz = v.position.z - p0.z;
      uvs.push(
        (dx * ux + dy * uy + dz * uz) * uvScale,
        (dx * vx + dy * vy + dz * vz) * uvScale,
      );
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

    // For very large meshes, skip snap detection entirely — too expensive
    if (mesh.vertices.size > 10000) {
      this.hideSnapMarker();
      return worldPoint;
    }

    let bestDist = Infinity;
    let bestPoint: { x: number; y: number; z: number } | null = null;

    // For large meshes, use a camera-ray proximity pre-filter instead of
    // projecting every vertex to screen (which requires matrix multiplication).
    const useFastFilter = mesh.vertices.size > 1000;
    let rayOrigin: { x: number; y: number; z: number } | null = null;
    let rayDir: { x: number; y: number; z: number } | null = null;
    let maxWorldDist = 0;

    if (useFastFilter) {
      const ray = camera.screenToRay(screenX, screenY, viewportWidth, viewportHeight);
      if (ray) {
        rayOrigin = ray.origin;
        rayDir = ray.direction;
        // Estimate world-space snap radius from screen pixels
        const camPos = camera.position || { x: 0, y: 10, z: 10 };
        const camDist = worldPoint ? Math.sqrt(
          (worldPoint.x - camPos.x) ** 2 + (worldPoint.y - camPos.y) ** 2 + (worldPoint.z - camPos.z) ** 2
        ) : 20;
        maxWorldDist = camDist * snapRadiusPx * 0.002; // Approximate screen-to-world scale
      }
    }

    // Check all vertex positions
    const margin = snapRadiusPx * 2;
    mesh.vertices.forEach((vertex) => {
      // Fast 3D proximity filter for large meshes: skip vertices far from cursor ray
      if (useFastFilter && rayOrigin && rayDir) {
        const toVert = {
          x: vertex.position.x - rayOrigin.x,
          y: vertex.position.y - rayOrigin.y,
          z: vertex.position.z - rayOrigin.z,
        };
        const t = toVert.x * rayDir.x + toVert.y * rayDir.y + toVert.z * rayDir.z;
        if (t < 0) return; // Behind camera
        const closestOnRay = {
          x: rayOrigin.x + rayDir.x * t,
          y: rayOrigin.y + rayDir.y * t,
          z: rayOrigin.z + rayDir.z * t,
        };
        const dx3d = vertex.position.x - closestOnRay.x;
        const dy3d = vertex.position.y - closestOnRay.y;
        const dz3d = vertex.position.z - closestOnRay.z;
        if (dx3d * dx3d + dy3d * dy3d + dz3d * dz3d > maxWorldDist * maxWorldDist) return;
      }

      const screenPos = camera.worldToScreen(vertex.position, viewportWidth, viewportHeight);
      if (screenPos.x < -margin || screenPos.x > viewportWidth + margin ||
          screenPos.y < -margin || screenPos.y > viewportHeight + margin) return;
      const dx = screenPos.x - screenX;
      const dy = screenPos.y - screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < snapRadiusPx && dist < bestDist) {
        bestDist = dist;
        bestPoint = { ...vertex.position };
      }
    });

    // Check edge midpoints (skip for large meshes — vertex snap is sufficient)
    if (mesh.edges.size <= 2000) {
      mesh.edges.forEach((edge) => {
        const v1 = mesh.vertices.get(edge.startVertexId);
        const v2 = mesh.vertices.get(edge.endVertexId);
        if (!v1 || !v2) return;

        const mid = {
          x: (v1.position.x + v2.position.x) / 2,
          y: (v1.position.y + v2.position.y) / 2,
          z: (v1.position.z + v2.position.z) / 2,
        };

        // Fast 3D proximity filter
        if (useFastFilter && rayOrigin && rayDir) {
          const toMid = { x: mid.x - rayOrigin.x, y: mid.y - rayOrigin.y, z: mid.z - rayOrigin.z };
          const t = toMid.x * rayDir.x + toMid.y * rayDir.y + toMid.z * rayDir.z;
          if (t < 0) return;
          const cx = rayOrigin.x + rayDir.x * t - mid.x;
          const cy = rayOrigin.y + rayDir.y * t - mid.y;
          const cz = rayOrigin.z + rayDir.z * t - mid.z;
          if (cx * cx + cy * cy + cz * cz > maxWorldDist * maxWorldDist) return;
        }

        const screenPos = camera.worldToScreen(mid, viewportWidth, viewportHeight);
        if (screenPos.x < -margin || screenPos.x > viewportWidth + margin ||
            screenPos.y < -margin || screenPos.y > viewportHeight + margin) return;
        const dx = screenPos.x - screenX;
        const dy = screenPos.y - screenY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < snapRadiusPx && dist < bestDist) {
          bestDist = dist;
          bestPoint = mid;
        }
      });
    }

    // Check edge-edge intersection points (skip if too many edges — O(n²) is too expensive)
    if (mesh.edges.size <= 500) {
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
    }

    // If we already found a vertex/midpoint/intersection snap, use it (higher priority)
    if (bestPoint) {
      this.showSnapMarker(bestPoint, camera);
      return bestPoint;
    }

    // On-edge snap: find the closest point on any edge to the cursor ray.
    // Lower priority than point snaps — only used when no point snap is found.
    // Skip for large meshes — too many edges to check per frame.
    const ray2 = mesh.edges.size <= 2000
      ? camera.screenToRay(screenX, screenY, viewportWidth, viewportHeight)
      : null;
    if (ray2) {
      let bestEdgeDist = Infinity;
      let bestEdgePoint: { x: number; y: number; z: number } | null = null;

      mesh.edges.forEach((edge) => {
        const v1 = mesh.vertices.get(edge.startVertexId);
        const v2 = mesh.vertices.get(edge.endVertexId);
        if (!v1 || !v2) return;

        // Closest point between ray and edge segment
        const p = this.closestPointOnSegmentToRay(
          v1.position, v2.position, ray2.origin, ray2.direction,
        );
        if (!p) return;

        // Check screen distance
        const sp = camera.worldToScreen(p, viewportWidth, viewportHeight);
        const dx = sp.x - screenX;
        const dy = sp.y - screenY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < snapRadiusPx * 0.7 && dist < bestEdgeDist) {
          bestEdgeDist = dist;
          bestEdgePoint = p;
        }
      });

      if (bestEdgePoint) {
        this.showOnEdgeMarker(bestEdgePoint, camera);
        return bestEdgePoint;
      }
    }

    // No snap — show marker at cursor world position if available
    if (worldPoint) {
      this.showCursorMarker(worldPoint, camera);
    } else {
      this.hideSnapMarker();
    }
    return worldPoint;
  }

  /**
   * Find the closest point on a line segment (a->b) to a ray (origin + t*dir).
   * Returns the point on the segment, or null if too far.
   */
  private closestPointOnSegmentToRay(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
    rayOrigin: { x: number; y: number; z: number },
    rayDir: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } | null {
    // Edge direction
    const edx = b.x - a.x, edy = b.y - a.y, edz = b.z - a.z;
    // w = a - rayOrigin
    const wx = a.x - rayOrigin.x, wy = a.y - rayOrigin.y, wz = a.z - rayOrigin.z;

    const aa = rayDir.x * rayDir.x + rayDir.y * rayDir.y + rayDir.z * rayDir.z;
    const bb = rayDir.x * edx + rayDir.y * edy + rayDir.z * edz;
    const cc = edx * edx + edy * edy + edz * edz;
    const dd = rayDir.x * wx + rayDir.y * wy + rayDir.z * wz;
    const ee = edx * wx + edy * wy + edz * wz;

    const denom = aa * cc - bb * bb;
    if (Math.abs(denom) < 1e-10) return null; // Parallel

    // s = parameter on edge segment (clamped to [0,1])
    let s = (bb * dd - aa * ee) / denom;
    s = Math.max(0, Math.min(1, s));

    // Skip if very close to endpoints (those are already handled by vertex snap)
    if (s < 0.05 || s > 0.95) return null;

    return {
      x: a.x + edx * s,
      y: a.y + edy * s,
      z: a.z + edz * s,
    };
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

  /** Show a red marker at an on-edge snap point. */
  private showOnEdgeMarker(point: { x: number; y: number; z: number }, camera: any): void {
    this.snapMarker.position.set(point.x, point.y, point.z);
    this.snapMarker.visible = true;
    this.snapActive = true;

    const camPos = camera.position;
    this.snapMarkerRing.lookAt(camPos.x, camPos.y, camPos.z);
    this.scaleMarkerToCamera(point, camera);

    (this.snapMarkerDot.material as THREE.MeshBasicMaterial).color.setHex(0xff4444);
    (this.snapMarkerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff4444);
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
