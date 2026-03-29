// @archigraph renderer.webgl
// WebGL renderer implementing IRenderer with Three.js

import * as THREE from 'three';
import { IRenderer, IRenderStats } from '../../src/core/interfaces';
import { Vec3, Color, RenderMode } from '../../src/core/types';
import { CameraController } from '../camera.main/CameraController';
import {
  createSelectionOutlineMaterial,
  createPreSelectionMaterial,
  SELECTION_COLOR,
  PRE_SELECTION_COLOR,
} from '../shader.selection/SelectionShader';
import { createXRayMaterial, createXRayWireframeMaterial } from '../shader.xray/XRayShader';

/** Maps entity IDs to their Three.js objects for picking and highlighting. */
type EntityObjectMap = Map<string, THREE.Object3D>;

export class WebGLRenderer implements IRenderer {
  private _renderer!: THREE.WebGLRenderer;
  private _scene: THREE.Scene;
  private _overlayScene: THREE.Scene;
  private _cameraController: CameraController;

  private _renderMode: RenderMode = 'shaded';
  private _animationFrameId: number | null = null;
  private _running = false;
  private _width = 1;
  private _height = 1;

  // Lighting
  private _ambientLight!: THREE.AmbientLight;
  private _sunLight!: THREE.DirectionalLight;

  // Overlays
  private _grid!: THREE.GridHelper;
  private _axes!: THREE.AxesHelper;
  private _gridVisible = true;
  private _axesVisible = true;

  // Guide lines
  private _guideLines: Map<string, THREE.Line> = new Map();
  private _guideGroup: THREE.Group;

  // Selection
  private _selectionOutlines: THREE.Group;
  private _preSelectionOutline: THREE.Group;
  private _selectedEntityIds: Set<string> = new Set();
  private _preSelectionEntityId: string | null = null;

  // Entity-to-object map (populated externally)
  private _entityObjects: EntityObjectMap = new Map();

  // Selection materials
  private _selectionMaterial: THREE.ShaderMaterial;
  private _preSelectionMaterial: THREE.ShaderMaterial;

  // Render mode material caches
  private _originalMaterials: Map<string, THREE.Material | THREE.Material[]> = new Map();

  // Raycaster
  private _raycaster: THREE.Raycaster;

  // Stats
  private _stats: IRenderStats = { fps: 0, frameTime: 0, drawCalls: 0, triangles: 0 };
  private _lastFrameTime = 0;
  private _frameCount = 0;
  private _fpsAccumulator = 0;
  private _lastFpsUpdate = 0;

  constructor(cameraController: CameraController) {
    this._cameraController = cameraController;
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0xd4d4d8);

    this._overlayScene = new THREE.Scene();

    this._guideGroup = new THREE.Group();
    this._guideGroup.name = 'guides';
    this._overlayScene.add(this._guideGroup);

    this._selectionOutlines = new THREE.Group();
    this._selectionOutlines.name = 'selection-outlines';
    this._overlayScene.add(this._selectionOutlines);

    this._preSelectionOutline = new THREE.Group();
    this._preSelectionOutline.name = 'pre-selection-outline';
    this._overlayScene.add(this._preSelectionOutline);

    this._selectionMaterial = createSelectionOutlineMaterial();
    this._preSelectionMaterial = createPreSelectionMaterial();

    this._raycaster = new THREE.Raycaster();
    this._raycaster.params.Line = { threshold: 0.1 };
    this._raycaster.params.Points = { threshold: 0.1 };
  }

  /** Returns the main Three.js scene for external manipulation. */
  getScene(): THREE.Scene {
    return this._scene;
  }

  /** Returns the overlay scene (grid, axes, guides, selections). */
  getOverlayScene(): THREE.Scene {
    return this._overlayScene;
  }

  /** Register an entity's Three.js object for picking/highlighting. */
  registerEntityObject(entityId: string, object: THREE.Object3D): void {
    object.userData.entityId = entityId;
    this._entityObjects.set(entityId, object);
  }

  /** Unregister an entity's Three.js object. */
  unregisterEntityObject(entityId: string): void {
    this._entityObjects.delete(entityId);
  }

  initialize(canvas: HTMLCanvasElement, width: number, height: number): void {
    this._width = width;
    this._height = height;

    this._renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this._renderer.setSize(width, height);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._renderer.autoClear = false;
    this._renderer.localClippingEnabled = true;
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.0;

    this._setupLighting();
    this._setupGrid();
    this._setupAxes();

    this._cameraController.updateAspect(width / height);
  }

  dispose(): void {
    this.stopRenderLoop();
    this._guideLines.forEach((line) => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    });
    this._guideLines.clear();
    this._selectionMaterial.dispose();
    this._preSelectionMaterial.dispose();
    this._renderer.dispose();
  }

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this._renderer.setSize(width, height);
    this._cameraController.updateAspect(width / height);
  }

  render(): void {
    const startTime = performance.now();

    this._cameraController.update();
    const camera = this._cameraController.getThreeCamera();

    this._renderer.clear(true, true, true);

    // Render main scene
    this._renderer.render(this._scene, camera);

    // Render overlay scene on top (no depth clear)
    this._renderer.clearDepth();
    this._renderer.render(this._overlayScene, camera);

    // Stats tracking
    const frameTime = performance.now() - startTime;
    this._stats.frameTime = frameTime;
    this._frameCount++;
    this._fpsAccumulator += frameTime;

    const now = performance.now();
    if (now - this._lastFpsUpdate >= 1000) {
      this._stats.fps = Math.round(this._frameCount / ((now - this._lastFpsUpdate) / 1000));
      this._frameCount = 0;
      this._fpsAccumulator = 0;
      this._lastFpsUpdate = now;
    }

    const info = this._renderer.info;
    this._stats.drawCalls = info.render.calls;
    this._stats.triangles = info.render.triangles;
  }

  startRenderLoop(): void {
    if (this._running) return;
    this._running = true;
    this._lastFpsUpdate = performance.now();
    this._frameCount = 0;

    const loop = (): void => {
      if (!this._running) return;
      this.render();
      this._animationFrameId = requestAnimationFrame(loop);
    };
    this._animationFrameId = requestAnimationFrame(loop);
  }

  stopRenderLoop(): void {
    this._running = false;
    if (this._animationFrameId !== null) {
      cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }
  }

  setRenderMode(mode: RenderMode): void {
    if (mode === this._renderMode) return;

    // Restore original materials before switching
    this._restoreOriginalMaterials();
    this._renderMode = mode;
    this._applyRenderMode();
  }

  getRenderMode(): RenderMode {
    return this._renderMode;
  }

  pick(screenX: number, screenY: number): { entityId: string; point: Vec3 } | null {
    const ndc = new THREE.Vector2(
      (screenX / this._width) * 2 - 1,
      -(screenY / this._height) * 2 + 1,
    );

    const camera = this._cameraController.getThreeCamera();
    this._raycaster.setFromCamera(ndc, camera);

    const intersects = this._raycaster.intersectObjects(this._scene.children, true);

    for (const hit of intersects) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        if (obj.userData.entityId) {
          return {
            entityId: obj.userData.entityId,
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
          };
        }
        obj = obj.parent;
      }
    }

    return null;
  }

  getStats(): IRenderStats {
    return { ...this._stats };
  }

  setSelectionHighlight(entityIds: string[]): void {
    // Restore previously highlighted objects
    this._restoreHighlighted();
    this._selectedEntityIds = new Set(entityIds);

    for (const id of entityIds) {
      const obj = this._entityObjects.get(id);
      if (!obj) continue;
      this._applyHighlight(obj, 'selection');
    }
  }

  setPreSelectionHighlight(entityId: string | null): void {
    // Restore previous pre-selection
    if (this._preSelectionEntityId && this._preSelectionEntityId !== entityId) {
      const prevObj = this._entityObjects.get(this._preSelectionEntityId);
      if (prevObj && !this._selectedEntityIds.has(this._preSelectionEntityId)) {
        this._restoreObject(prevObj);
      }
    }
    this._preSelectionEntityId = entityId;

    if (entityId && !this._selectedEntityIds.has(entityId)) {
      const obj = this._entityObjects.get(entityId);
      if (obj) {
        this._applyHighlight(obj, 'preselection');
      }
    }
  }

  // Selection highlight materials
  private _selHighlightFace = new THREE.MeshBasicMaterial({
    color: 0x3388ff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  private _selHighlightEdge = new THREE.LineBasicMaterial({
    color: 0x00aaff,
    linewidth: 5,
  });

  private _preSelHighlightFace = new THREE.MeshBasicMaterial({
    color: 0xffaa22,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  private _preSelHighlightEdge = new THREE.LineBasicMaterial({
    color: 0xff8800,
    linewidth: 5,
  });

  // Store original materials for restoration
  private _highlightedObjects = new Map<string, { obj: THREE.Object3D; origMaterial: THREE.Material | THREE.Material[] }>();

  private _applyHighlight(obj: THREE.Object3D, mode: 'selection' | 'preselection'): void {
    const id = obj.userData.entityId;
    if (!id) return;

    if (obj instanceof THREE.Mesh) {
      if (!this._highlightedObjects.has(id)) {
        this._highlightedObjects.set(id, { obj, origMaterial: obj.material });
      }
      obj.material = mode === 'selection' ? this._selHighlightFace : this._preSelHighlightFace;

      // Also highlight sibling meshes in the same group (front+back face meshes)
      if (obj.parent && obj.parent !== this._scene) {
        obj.parent.traverse(child => {
          if (child !== obj && child instanceof THREE.Mesh) {
            if (!this._highlightedObjects.has(child.uuid)) {
              this._highlightedObjects.set(child.uuid, { obj: child, origMaterial: child.material });
            }
            child.material = mode === 'selection' ? this._selHighlightFace : this._preSelHighlightFace;
          }
        });
      }
    } else if (obj instanceof THREE.Line) {
      // Highlight edges by swapping material + adding a glow tube
      if (!this._highlightedObjects.has(id)) {
        this._highlightedObjects.set(id, { obj, origMaterial: obj.material as THREE.Material });
      }
      obj.material = mode === 'selection' ? this._selHighlightEdge : this._preSelHighlightEdge;

      // Add a tube mesh along the edge for visible thickness
      const positions = (obj.geometry as THREE.BufferGeometry).getAttribute('position');
      if (positions && positions.count >= 2) {
        const p1 = new THREE.Vector3(positions.getX(0), positions.getY(0), positions.getZ(0));
        const p2 = new THREE.Vector3(positions.getX(1), positions.getY(1), positions.getZ(1));
        const dir = new THREE.Vector3().subVectors(p2, p1);
        const len = dir.length();
        if (len > 0.001) {
          // Scale tube radius by camera distance so highlight looks constant on screen
          const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
          const camPos = this._cameraController.getThreeCamera().position;
          const camDist = mid.distanceTo(camPos);
          const tubeRadius = Math.max(camDist * 0.003, 0.005);
          const tubeGeo = new THREE.CylinderGeometry(tubeRadius, tubeRadius, len, 6, 1);
          tubeGeo.rotateX(Math.PI / 2);
          const color = mode === 'selection' ? 0x00aaff : 0xff8800;
          const tubeMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false });
          const tube = new THREE.Mesh(tubeGeo, tubeMat);
          tube.name = `edge-glow-${id}`;
          tube.position.copy(p1).lerp(p2, 0.5);
          tube.lookAt(p2);
          tube.raycast = () => {}; // Non-raycastable
          (obj as any).__glowTube = tube;
          this._overlayScene.add(tube);
        }
      }
    }
  }

  private _restoreObject(obj: THREE.Object3D): void {
    const id = obj.userData.entityId;
    if (!id) return;

    const saved = this._highlightedObjects.get(id);
    if (saved && (saved.obj instanceof THREE.Mesh || saved.obj instanceof THREE.Line)) {
      (saved.obj as any).material = saved.origMaterial;
      // Remove glow tube if present
      if ((saved.obj as any).__glowTube) {
        const tube = (saved.obj as any).__glowTube;
        this._overlayScene.remove(tube);
        tube.geometry.dispose();
        (tube.material as THREE.Material).dispose();
        delete (saved.obj as any).__glowTube;
      }
      this._highlightedObjects.delete(id);
    }

    // Restore parent group children too
    if (obj.parent && obj.parent !== this._scene) {
      obj.parent.traverse(child => {
        const childSaved = this._highlightedObjects.get(child.uuid);
        if (childSaved && (childSaved.obj instanceof THREE.Mesh || childSaved.obj instanceof THREE.Line)) {
          (childSaved.obj as any).material = childSaved.origMaterial;
          this._highlightedObjects.delete(child.uuid);
        }
      });
    }
  }

  private _restoreHighlighted(): void {
    for (const [, { obj, origMaterial }] of this._highlightedObjects) {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        (obj as any).material = origMaterial;
      }
      // Remove glow tubes
      if ((obj as any).__glowTube) {
        const tube = (obj as any).__glowTube;
        this._overlayScene.remove(tube);
        tube.geometry.dispose();
        (tube.material as THREE.Material).dispose();
        delete (obj as any).__glowTube;
      }
    }
    this._highlightedObjects.clear();
  }

  addGuideLine(id: string, start: Vec3, end: Vec3, color: Color, dashed?: boolean): void {
    this.removeGuideLine(id);

    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(start.x, start.y, start.z),
      new THREE.Vector3(end.x, end.y, end.z),
    ]);

    let material: THREE.Material;
    const threeColor = new THREE.Color(color.r, color.g, color.b);

    if (dashed) {
      material = new THREE.LineDashedMaterial({
        color: threeColor,
        dashSize: 0.2,
        gapSize: 0.1,
        linewidth: 1,
      });
    } else {
      material = new THREE.LineBasicMaterial({
        color: threeColor,
        linewidth: 1,
      });
    }

    const line = new THREE.Line(geometry, material);
    if (dashed) line.computeLineDistances();
    line.name = `guide-${id}`;

    this._guideLines.set(id, line);
    this._guideGroup.add(line);
  }

  removeGuideLine(id: string): void {
    const line = this._guideLines.get(id);
    if (line) {
      this._guideGroup.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      this._guideLines.delete(id);
    }
  }

  clearGuideLines(): void {
    this._guideLines.forEach((line) => {
      this._guideGroup.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    });
    this._guideLines.clear();
  }

  setGridVisible(visible: boolean): void {
    this._gridVisible = visible;
    this._grid.visible = visible;
  }

  setAxesVisible(visible: boolean): void {
    this._axesVisible = visible;
    this._axes.visible = visible;
  }

  setSectionPlane(plane: { point: Vec3; normal: Vec3 } | null): void {
    if (!plane) {
      // Clear clipping on all scene materials
      this._scene.traverse((obj) => {
        if ((obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material as THREE.Material;
          if (Array.isArray(mat)) {
            mat.forEach(m => { m.clippingPlanes = []; });
          } else {
            mat.clippingPlanes = [];
          }
        }
      });
      return;
    }

    const { point, normal } = plane;
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const constant = -n.dot(new THREE.Vector3(point.x, point.y, point.z));
    const clipPlane = new THREE.Plane(n, constant);

    this._scene.traverse((obj) => {
      if ((obj as THREE.Mesh).material) {
        const mat = (obj as THREE.Mesh).material as THREE.Material;
        if (Array.isArray(mat)) {
          mat.forEach(m => { m.clippingPlanes = [clipPlane]; });
        } else {
          mat.clippingPlanes = [clipPlane];
        }
      }
    });
  }

  // ─── Private ───────────────────────────────────────────────────

  private _setupLighting(): void {
    this._ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this._scene.add(this._ambientLight);

    this._sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this._sunLight.position.set(50, 80, 50);
    this._sunLight.castShadow = true;
    this._sunLight.shadow.mapSize.width = 2048;
    this._sunLight.shadow.mapSize.height = 2048;
    this._sunLight.shadow.camera.left = -50;
    this._sunLight.shadow.camera.right = 50;
    this._sunLight.shadow.camera.top = 50;
    this._sunLight.shadow.camera.bottom = -50;
    this._sunLight.shadow.camera.near = 0.1;
    this._sunLight.shadow.camera.far = 200;
    this._sunLight.shadow.bias = -0.005;
    this._scene.add(this._sunLight);

    // Hemisphere light for softer fill
    const hemiLight = new THREE.HemisphereLight(0xb1e1ff, 0xb97a20, 0.3);
    this._scene.add(hemiLight);
  }

  private _setupGrid(): void {
    // Infinite grid using a shader on a large plane
    const gridVertexShader = `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const gridFragmentShader = `
      varying vec3 vWorldPos;
      uniform float gridSpacing;
      uniform float subGridSpacing;
      uniform vec3 gridColor;
      uniform vec3 subGridColor;
      uniform float fadeDistance;

      float gridLine(float coord, float spacing, float lineWidth) {
        float d = abs(fract(coord / spacing - 0.5) - 0.5) * spacing;
        return 1.0 - smoothstep(0.0, lineWidth, d);
      }

      void main() {
        float dist = length(vWorldPos.xz);
        float fade = 1.0 - smoothstep(fadeDistance * 0.3, fadeDistance, dist);
        if (fade < 0.01) discard;

        float lineWidth = 0.02;
        float mainLine = max(
          gridLine(vWorldPos.x, gridSpacing, lineWidth),
          gridLine(vWorldPos.z, gridSpacing, lineWidth)
        );
        float subLine = max(
          gridLine(vWorldPos.x, subGridSpacing, lineWidth * 0.5),
          gridLine(vWorldPos.z, subGridSpacing, lineWidth * 0.5)
        );

        float alpha = max(mainLine * 0.4, subLine * 0.15) * fade;
        if (alpha < 0.01) discard;

        vec3 color = mainLine > 0.01 ? gridColor : subGridColor;
        gl_FragColor = vec4(color, alpha);
      }
    `;

    const gridMaterial = new THREE.ShaderMaterial({
      vertexShader: gridVertexShader,
      fragmentShader: gridFragmentShader,
      uniforms: {
        gridSpacing: { value: 1.0 },
        subGridSpacing: { value: 0.1 },
        gridColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        subGridColor: { value: new THREE.Vector3(0.7, 0.7, 0.7) },
        fadeDistance: { value: 50.0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const gridGeometry = new THREE.PlaneGeometry(1000, 1000);
    gridGeometry.rotateX(-Math.PI / 2); // Lay flat on XZ plane
    this._grid = new THREE.Mesh(gridGeometry, gridMaterial) as any;
    this._grid.renderOrder = -1;
    (this._grid as any).raycast = () => {}; // Non-raycastable
    this._overlayScene.add(this._grid);
  }

  private _setupAxes(): void {
    this._axes = new THREE.AxesHelper(50);
    this._axes.renderOrder = 0;
    this._overlayScene.add(this._axes);
  }

  private _clearGroup(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }
  }

  private _addOutlineClone(
    source: THREE.Object3D,
    parent: THREE.Group,
    material: THREE.ShaderMaterial,
  ): void {
    source.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const clone = new THREE.Mesh(child.geometry, material);
        clone.position.copy(child.position);
        clone.rotation.copy(child.rotation);
        clone.scale.copy(child.scale);
        child.updateWorldMatrix(true, false);
        clone.applyMatrix4(child.matrixWorld);
        parent.add(clone);
      }
    });
  }

  private _restoreOriginalMaterials(): void {
    this._originalMaterials.forEach((mat, uuid) => {
      const obj = this._scene.getObjectByProperty('uuid', uuid);
      if (obj && obj instanceof THREE.Mesh) {
        obj.material = mat;
      }
    });
    this._originalMaterials.clear();
  }

  private _applyRenderMode(): void {
    this._scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;

      // Store original material
      if (!this._originalMaterials.has(obj.uuid)) {
        this._originalMaterials.set(obj.uuid, obj.material);
      }

      switch (this._renderMode) {
        case 'wireframe':
          obj.material = new THREE.MeshBasicMaterial({
            color: 0x333333,
            wireframe: true,
          });
          break;

        case 'hiddenLine': {
          // Solid white fill + wireframe overlay
          const fillMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          });
          const wireMat = new THREE.MeshBasicMaterial({
            color: 0x333333,
            wireframe: true,
          });
          obj.material = [fillMat, wireMat];
          break;
        }

        case 'shaded':
          // Restore originals (already handled by _restoreOriginalMaterials)
          // If no original, use default standard material
          if (!this._originalMaterials.has(obj.uuid)) {
            obj.material = new THREE.MeshStandardMaterial({
              color: 0xd9d9d9,
              roughness: 0.7,
              metalness: 0.0,
              side: THREE.DoubleSide,
            });
          }
          break;

        case 'textured':
          // Keep original materials (with textures) or use standard
          if (!this._originalMaterials.has(obj.uuid)) {
            obj.material = new THREE.MeshStandardMaterial({
              color: 0xd9d9d9,
              roughness: 0.7,
              metalness: 0.0,
              side: THREE.DoubleSide,
            });
          }
          break;

        case 'xray':
          obj.material = createXRayMaterial();
          break;
      }
    });
  }
}
