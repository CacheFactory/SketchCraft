// @archigraph renderer.scene-bridge
// Synchronizes the geometry engine's B-Rep data with Three.js scene objects.

import * as THREE from 'three';
import type { IGeometryEngine, IFace, IEdge, ISceneManager } from '../core/interfaces';
import type { WebGLRenderer } from './WebGLRenderer';
import type { SceneManager } from '../data/SceneManager';

export class SceneBridge {
  private engine: IGeometryEngine;
  private sceneManager: SceneManager | null = null;
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
      flatShading: false, // Smooth shading hides internal triangle edges
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.backFaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x8888cc,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.BackSide,
      flatShading: true,
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

    // Build triangle geometry (fan triangulation)
    const positions: number[] = [];
    const normals: number[] = [];
    const n = face.normal;

    for (let i = 1; i < verts.length - 1; i++) {
      positions.push(verts[0].position.x, verts[0].position.y, verts[0].position.z);
      positions.push(verts[i].position.x, verts[i].position.y, verts[i].position.z);
      positions.push(verts[i + 1].position.x, verts[i + 1].position.y, verts[i + 1].position.z);
      normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));

    if (this.faceGroups.has(id)) {
      // Update: replace geometry on existing meshes
      const group = this.faceGroups.get(id)!;
      group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          child.geometry = geometry;
        }
      });
    } else {
      // Create new group with front + back meshes
      const group = new THREE.Group();
      group.name = `face-${id}`;
      group.userData.entityId = id;
      group.userData.entityType = 'face';

      const frontMesh = new THREE.Mesh(geometry, this.faceMaterial.clone());
      frontMesh.castShadow = true;
      frontMesh.receiveShadow = true;
      frontMesh.userData.entityId = id;
      frontMesh.userData.entityType = 'face';

      const backMesh = new THREE.Mesh(geometry, this.backFaceMaterial.clone());
      backMesh.userData.entityId = id;

      group.add(frontMesh);
      group.add(backMesh);

      this.scene.add(group);
      this.faceGroups.set(id, group);
      // Register the frontMesh for raycasting (it has the entityId)
      this.webglRenderer.registerEntityObject(id, frontMesh);
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

  /** Show the green snap marker at a snapped endpoint. */
  private showSnapMarker(point: { x: number; y: number; z: number }, camera: any): void {
    this.snapMarker.position.set(point.x, point.y, point.z);
    this.snapMarker.visible = true;
    this.snapActive = true;

    // Make the ring face the camera
    const camPos = camera.position;
    this.snapMarkerRing.lookAt(camPos.x, camPos.y, camPos.z);

    // Green = snapped
    (this.snapMarkerDot.material as THREE.MeshBasicMaterial).color.setHex(0x00cc44);
    (this.snapMarkerRing.material as THREE.MeshBasicMaterial).color.setHex(0x00cc44);
    this.snapMarkerRing.visible = true;
  }

  /** Show a small blue marker at cursor position (no snap). */
  private showCursorMarker(point: { x: number; y: number; z: number }, camera: any): void {
    this.snapMarker.position.set(point.x, point.y, point.z);
    this.snapMarker.visible = true;
    this.snapActive = false;

    // Make the ring face the camera
    const camPos = camera.position;
    this.snapMarkerRing.lookAt(camPos.x, camPos.y, camPos.z);

    // Blue = not snapped, just cursor position
    (this.snapMarkerDot.material as THREE.MeshBasicMaterial).color.setHex(0x3388ff);
    (this.snapMarkerRing.material as THREE.MeshBasicMaterial).color.setHex(0x3388ff);
    this.snapMarkerRing.visible = false; // Only show dot when not snapped
  }

  hideSnapMarker(): void {
    this.snapMarker.visible = false;
    this.snapActive = false;
  }

  get isSnapped(): boolean {
    return this.snapActive;
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
