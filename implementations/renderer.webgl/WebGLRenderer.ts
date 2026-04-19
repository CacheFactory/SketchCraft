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
  private _preSelectionEntityIds: Set<string> = new Set();

  // Entity-to-object map (populated externally)
  private _entityObjects: EntityObjectMap = new Map();

  // Selection materials
  private _selectionMaterial: THREE.ShaderMaterial;
  private _preSelectionMaterial: THREE.ShaderMaterial;

  // Render mode material caches
  private _originalMaterials: Map<string, THREE.Material | THREE.Material[]> = new Map();

  // Raycaster
  private _raycaster: THREE.Raycaster;

  // GPU picking
  private _pickRenderTarget: THREE.WebGLRenderTarget | null = null;
  private _pickScene: THREE.Scene;
  private _pickOverlayScene: THREE.Scene;
  private _pickMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private _pickLineMaterials = new Map<string, THREE.LineBasicMaterial>(); // track line materials for disposal
  private _pickIdToEntity = new Map<number, string>(); // encoded color -> entityId
  private _pickEntityToId = new Map<string, number>(); // entityId -> encoded color
  private _nextPickId = 1;
  private _pickPixelBuffer = new Uint8Array(4);
  private _gpuPickLogCounter = 0;
  private _pickSceneDirty = true;  // rebuild pick scene objects (entity added/removed)
  private _pickBufferDirty = true; // re-render pick buffer (camera moved)
  // Batched pick mesh (vertex-color encoded face IDs)
  private _batchedPickMesh: THREE.Mesh | null = null;
  private _batchedPickIdToFace: Map<number, string> = new Map();
  private _batchedFaceHighlightFn: ((faceId: string) => THREE.BufferGeometry | null) | null = null;
  // Temporary highlight meshes for batched faces
  private _batchedHighlights = new Map<string, THREE.Mesh>();
  // Camera movement detection — numeric comparison avoids string allocation per frame
  private _lastCamX = NaN;
  private _lastCamY = NaN;
  private _lastCamZ = NaN;

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

    this._pickScene = new THREE.Scene();
    this._pickScene.background = new THREE.Color(0x000000); // black = no entity
    this._pickOverlayScene = new THREE.Scene();
  }

  /** Whether picking is available (per-entity objects or batched pick mesh). */
  hasEntityObjects(): boolean {
    return this._entityObjects.size > 0 || this._batchedPickMesh !== null;
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
    this._pickSceneDirty = true;
    this._pickBufferDirty = true;
  }

  /** Unregister an entity's Three.js object. */
  unregisterEntityObject(entityId: string): void {
    this._entityObjects.delete(entityId);
    this._pickSceneDirty = true;
    this._pickBufferDirty = true;
  }

  /** Register a function to create highlight geometry for a batched face. */
  setBatchedFaceHighlightFn(fn: (faceId: string) => THREE.BufferGeometry | null): void {
    this._batchedFaceHighlightFn = fn;
  }

  /** Register a batched pick mesh with vertex-color-encoded face IDs for GPU picking. */
  setBatchedPickMesh(mesh: THREE.Mesh, pickIdToFace: Map<number, string>): void {
    this._batchedPickMesh = mesh;
    this._batchedPickIdToFace = pickIdToFace;
    // Ensure per-entity pick IDs don't collide with batched pick IDs
    this._nextPickId = Math.max(this._nextPickId, pickIdToFace.size + 1);
    this._pickSceneDirty = true;
    this._pickBufferDirty = true;
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

    // GPU picking render target (1:1 pixel ratio for accurate reads)
    this._pickRenderTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    this._cameraController.updateAspect(width / height);
  }

  dispose(): void {
    this.stopRenderLoop();
    this._clearBatchedHighlights();
    if (this._batchedPickMesh) {
      this._batchedPickMesh.geometry.dispose();
      (this._batchedPickMesh.material as THREE.Material).dispose();
      this._batchedPickMesh = null;
    }
    this._guideLines.forEach((line) => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    });
    this._guideLines.clear();
    this._selectionMaterial.dispose();
    this._preSelectionMaterial.dispose();
    this._pickRenderTarget?.dispose();
    this._pickMaterials.forEach(m => m.dispose());
    this._pickMaterials.clear();
    this._pickLineMaterials.forEach(m => m.dispose());
    this._pickLineMaterials.clear();
    // Dispose glow tube pool
    this._glowTubeGeo?.dispose();
    this._glowSelMat.dispose();
    this._glowPreSelMat.dispose();
    this._glowTubePool.length = 0;
    this._renderer.dispose();
  }

  // ── GPU Picking ─────────────────────────────────────────────────

  /** Mark the pick buffer as needing re-render (call after scene changes). */
  invalidatePick(): void {
    this._pickSceneDirty = true;
    this._pickBufferDirty = true;
  }

  /** Encode an entity ID as a unique color for GPU picking. */
  private getPickId(entityId: string): number {
    let id = this._pickEntityToId.get(entityId);
    if (id !== undefined) return id;
    id = this._nextPickId++;
    this._pickEntityToId.set(entityId, id);
    this._pickIdToEntity.set(id, entityId);
    return id;
  }

  /** Convert a pick ID to raw RGB floats (0-1 range, no color space conversion). */
  private pickIdToRGB(id: number): [number, number, number] {
    return [
      ((id >> 16) & 0xff) / 255,
      ((id >> 8) & 0xff) / 255,
      (id & 0xff) / 255,
    ];
  }

  /** Vertex shader shared by all pick materials. */
  private static readonly PICK_VERT = `
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  /** Fragment shader shared by all pick materials. */
  private static readonly PICK_FRAG = `
    uniform vec3 pickColor;
    void main() {
      gl_FragColor = vec4(pickColor, 1.0);
    }
  `;

  /** Rebuild the pick scene by cloning geometry with pick-color materials. */
  private rebuildPickScene(): void {
    const t0 = performance.now();
    console.log(`[rebuildPickScene] starting, ${this._entityObjects.size} entities`);
    // Dispose previous pick scene objects (geometry is shared, don't dispose it; but remove references)
    for (const child of [...this._pickScene.children]) {
      this._pickScene.remove(child);
    }
    for (const child of [...this._pickOverlayScene.children]) {
      this._pickOverlayScene.remove(child);
    }
    // Dispose old pick materials (ShaderMaterials are created fresh each rebuild)
    this._pickMaterials.forEach(m => m.dispose());
    this._pickMaterials.clear();
    this._pickLineMaterials.forEach(m => m.dispose());
    this._pickLineMaterials.clear();

    // Clone main scene objects with raw ShaderMaterial pick colors (bypasses color management)
    this._entityObjects.forEach((obj, entityId) => {
      const pickId = this.getPickId(entityId);
      const [r, g, b] = this.pickIdToRGB(pickId);

      // Create ShaderMaterial with raw pick color uniform
      const pickMat = new THREE.ShaderMaterial({
        uniforms: { pickColor: { value: new THREE.Vector3(r, g, b) } },
        vertexShader: WebGLRenderer.PICK_VERT,
        fragmentShader: WebGLRenderer.PICK_FRAG,
        side: THREE.DoubleSide,
      });

      if (obj instanceof THREE.Mesh) {
        const pickMesh = new THREE.Mesh(obj.geometry, pickMat);
        pickMesh.matrixAutoUpdate = false;
        pickMesh.matrix.copy(obj.matrixWorld);
        pickMesh.visible = obj.visible;
        this._pickScene.add(pickMesh);
      } else if (obj instanceof THREE.Line) {
        const pickLine = new THREE.Line(obj.geometry, pickMat);
        pickLine.matrixAutoUpdate = false;
        pickLine.matrix.copy(obj.matrixWorld);
        pickLine.visible = obj.visible;
        this._pickOverlayScene.add(pickLine);
      }

      // Handle groups (face groups contain a mesh child)
      if (obj.parent && obj.parent.userData.entityId === entityId) {
        // Already handled the mesh directly
      } else if (obj instanceof THREE.Group) {
        obj.traverse(child => {
          if (child instanceof THREE.Mesh && child !== (obj as any)) {
            const pickMesh = new THREE.Mesh(child.geometry, pickMat);
            pickMesh.matrixAutoUpdate = false;
            pickMesh.matrix.copy(child.matrixWorld);
            pickMesh.visible = child.visible;
            this._pickScene.add(pickMesh);
          }
        });
      }
    });

    // Add batched pick mesh if available (vertex colors encode face IDs)
    if (this._batchedPickMesh) {
      this._pickScene.add(this._batchedPickMesh);
    }

    console.log(`[rebuildPickScene] done in ${(performance.now() - t0).toFixed(1)}ms, pick scene: ${this._pickScene.children.length}, pick overlay: ${this._pickOverlayScene.children.length}, batched: ${this._batchedPickMesh ? 'yes' : 'no'}`);
  }

  /** Render the pick buffer and read the pixel at (screenX, screenY).
   *  Returns the entity ID under the cursor, or null. */
  gpuPick(screenX: number, screenY: number): string | null {
    if (!this._pickRenderTarget || !this._renderer) return null;

    const camera = this._cameraController.getThreeCamera();
    camera.updateMatrixWorld(true);

    // Rebuild pick scene objects only when entities are added/removed
    if (this._pickSceneDirty) {
      this.rebuildPickScene();
      this._pickSceneDirty = false;
      this._pickBufferDirty = true; // must re-render after rebuild
    }

    // Re-render pick buffer when camera moved or scene rebuilt
    if (this._pickBufferDirty) {
      const currentRT = this._renderer.getRenderTarget();
      const currentToneMapping = this._renderer.toneMapping;
      const currentOutputColorSpace = this._renderer.outputColorSpace;

      this._renderer.toneMapping = THREE.NoToneMapping;
      this._renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      this._renderer.setRenderTarget(this._pickRenderTarget);
      this._renderer.clear(true, true, true);
      this._renderer.render(this._pickScene, camera);
      this._renderer.clearDepth();
      this._renderer.render(this._pickOverlayScene, camera);

      this._renderer.setRenderTarget(currentRT);
      this._renderer.toneMapping = currentToneMapping;
      this._renderer.outputColorSpace = currentOutputColorSpace;

      this._pickBufferDirty = false;
    }

    // Read single pixel under cursor
    // Note: WebGL Y is flipped relative to screen Y
    // Pick render target is CSS-sized (width × height), NOT scaled by pixelRatio,
    // so use CSS coordinates directly for readRenderTargetPixels.
    const x = Math.floor(screenX);
    const y = Math.floor(this._height - screenY);

    this._renderer.readRenderTargetPixels(
      this._pickRenderTarget, x, y, 1, 1, this._pickPixelBuffer,
    );

    const [r, g, b, a] = this._pickPixelBuffer;
    const pickId = (r << 16) | (g << 8) | b;

    // Debug: log every 60th call to avoid spam
    if (!this._gpuPickLogCounter) this._gpuPickLogCounter = 0;
    this._gpuPickLogCounter++;
    if (this._gpuPickLogCounter % 60 === 1) {
      console.log(`[gpuPick] pixel at (${screenX},${screenY}): r=${r} g=${g} b=${b} a=${a} -> pickId=${pickId}, pickScene children=${this._pickScene.children.length}, dirty=${this._pickSceneDirty}/${this._pickBufferDirty}, entities=${this._entityObjects.size}, batchedMap=${this._batchedPickIdToFace.size}`);
    }

    if (pickId === 0) return null; // Background (no entity)

    // Check batched face pick IDs first, then per-entity pick IDs
    const batchedFace = this._batchedPickIdToFace.get(pickId);
    if (batchedFace) {
      console.log(`[gpuPick] batched hit: pickId=${pickId} -> ${batchedFace}`);
      return batchedFace;
    }

    const entityHit = this._pickIdToEntity.get(pickId) || null;
    if (entityHit) {
      console.log(`[gpuPick] entity hit: pickId=${pickId} -> ${entityHit}`);
    }
    return entityHit;
  }

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this._renderer.setSize(width, height);
    this._pickRenderTarget?.setSize(width, height);
    this._pickBufferDirty = true;
    this._cameraController.updateAspect(width / height);
  }

  // Performance logging — throttled to once per second
  private _lastPerfLog = 0;
  private _perfFrameCount = 0;
  private _perfMainTotal = 0;
  private _perfOverlayTotal = 0;
  private _perfUpdateTotal = 0;

  render(): void {
    const startTime = performance.now();

    const t0 = performance.now();
    this._cameraController.update();
    const camera = this._cameraController.getThreeCamera();
    const tUpdate = performance.now() - t0;

    // Only mark pick buffer dirty when camera actually moves (numeric compare, no allocation)
    const pos = camera.position;
    if (pos.x !== this._lastCamX || pos.y !== this._lastCamY || pos.z !== this._lastCamZ) {
      this._lastCamX = pos.x;
      this._lastCamY = pos.y;
      this._lastCamZ = pos.z;
      this._pickBufferDirty = true;
    }

    this._renderer.clear(true, true, true);

    // Render main scene
    const t1 = performance.now();
    this._renderer.render(this._scene, camera);
    const tMain = performance.now() - t1;

    // Render overlay scene on top (no depth clear)
    this._renderer.clearDepth();
    const t2 = performance.now();
    this._renderer.render(this._overlayScene, camera);
    const tOverlay = performance.now() - t2;

    // Accumulate and log once per second
    this._perfFrameCount++;
    this._perfMainTotal += tMain;
    this._perfOverlayTotal += tOverlay;
    this._perfUpdateTotal += tUpdate;
    if (startTime - this._lastPerfLog >= 1000) {
      const n = this._perfFrameCount;
      const info = this._renderer.info;
      console.log(
        `[Render] ${n} frames/s | main: ${(this._perfMainTotal / n).toFixed(1)}ms | overlay: ${(this._perfOverlayTotal / n).toFixed(1)}ms | update: ${(this._perfUpdateTotal / n).toFixed(1)}ms | drawCalls: ${info.render.calls} | tris: ${info.render.triangles} | scene children: ${this._scene.children.length} | overlay children: ${this._overlayScene.children.length}`
      );
      this._perfFrameCount = 0;
      this._perfMainTotal = 0;
      this._perfOverlayTotal = 0;
      this._perfUpdateTotal = 0;
      this._lastPerfLog = startTime;
    }

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

  // Reusable NDC vector for pick() — avoids allocation per call
  private _pickNdc = new THREE.Vector2();

  pick(screenX: number, screenY: number): { entityId: string; point: Vec3 } | null {
    const ndc = this._pickNdc.set(
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
    return this._stats;
  }

  setSelectionHighlight(entityIds: string[]): void {
    // Restore previously highlighted objects
    this._restoreHighlighted();
    // Remove old batched highlights
    this._clearBatchedHighlights();
    this._selectedEntityIds = new Set(entityIds);

    for (const id of entityIds) {
      const obj = this._entityObjects.get(id);
      if (obj) {
        this._applyHighlight(obj, 'selection');
      } else {
        // Try batched face highlight
        this._addBatchedHighlight(id, 'selection');
      }
    }
  }

  setPreSelectionHighlight(entityId: string | null): void {
    this.setPreSelectionHighlightMulti(entityId ? [entityId] : []);
  }

  setPreSelectionHighlightMulti(entityIds: string[]): void {
    // Restore previous pre-selection entities
    for (const prevId of this._preSelectionEntityIds) {
      if (!entityIds.includes(prevId)) {
        const prevObj = this._entityObjects.get(prevId);
        if (prevObj && !this._selectedEntityIds.has(prevId)) {
          this._restoreObject(prevObj);
        }
        // Remove batched highlight for deselected entities
        this._removeBatchedHighlight(prevId);
      }
    }

    this._preSelectionEntityIds = new Set(entityIds);

    for (const id of entityIds) {
      if (!this._selectedEntityIds.has(id)) {
        const obj = this._entityObjects.get(id);
        if (obj) {
          this._applyHighlight(obj, 'preselection');
        } else {
          // Try batched face highlight
          this._addBatchedHighlight(id, 'preselection');
        }
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
    color: 0x4488ff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  private _preSelHighlightEdge = new THREE.LineBasicMaterial({
    color: 0x2266dd,
    linewidth: 5,
  });

  // Store original materials for restoration
  private _highlightedObjects = new Map<string, { obj: THREE.Object3D; origMaterial: THREE.Material | THREE.Material[] }>();

  // Reusable vectors for highlight calculations (avoid allocation per call)
  private _hlP1 = new THREE.Vector3();
  private _hlP2 = new THREE.Vector3();
  private _hlDir = new THREE.Vector3();
  private _hlMid = new THREE.Vector3();

  // Glow tube pool: reuse geometry + material instead of creating new ones each hover
  private _glowTubePool: THREE.Mesh[] = [];
  private _glowTubeGeo: THREE.CylinderGeometry | null = null;
  private _glowSelMat = new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.7, depthTest: false });
  private _glowPreSelMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.7, depthTest: false });

  private _getGlowTube(): THREE.Mesh {
    const pooled = this._glowTubePool.pop();
    if (pooled) return pooled;
    // Create shared geometry once (unit cylinder, will be scaled per-edge)
    if (!this._glowTubeGeo) {
      this._glowTubeGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
      this._glowTubeGeo.rotateX(Math.PI / 2);
    }
    const tube = new THREE.Mesh(this._glowTubeGeo, this._glowSelMat);
    tube.raycast = () => {}; // Non-raycastable
    return tube;
  }

  private _returnGlowTube(tube: THREE.Mesh): void {
    this._overlayScene.remove(tube);
    this._glowTubePool.push(tube);
  }

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
      // Highlight edges by swapping material + adding a reusable glow tube
      if (!this._highlightedObjects.has(id)) {
        this._highlightedObjects.set(id, { obj, origMaterial: obj.material as THREE.Material });
      }
      obj.material = mode === 'selection' ? this._selHighlightEdge : this._preSelHighlightEdge;

      // Add a tube mesh along the edge for visible thickness (reuse from pool)
      const positions = (obj.geometry as THREE.BufferGeometry).getAttribute('position');
      if (positions && positions.count >= 2) {
        this._hlP1.set(positions.getX(0), positions.getY(0), positions.getZ(0));
        this._hlP2.set(positions.getX(1), positions.getY(1), positions.getZ(1));
        this._hlDir.subVectors(this._hlP2, this._hlP1);
        const len = this._hlDir.length();
        if (len > 0.001) {
          // Scale tube radius by camera distance so highlight looks constant on screen
          this._hlMid.addVectors(this._hlP1, this._hlP2).multiplyScalar(0.5);
          const camPos = this._cameraController.getThreeCamera().position;
          const camDist = this._hlMid.distanceTo(camPos);
          const tubeRadius = Math.max(camDist * 0.003, 0.005);

          const tube = this._getGlowTube();
          tube.material = mode === 'selection' ? this._glowSelMat : this._glowPreSelMat;
          tube.name = `edge-glow-${id}`;
          tube.position.copy(this._hlMid);
          tube.scale.set(tubeRadius, tubeRadius, len);
          tube.lookAt(this._hlP2);
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
      // Return glow tube to pool instead of disposing
      if ((saved.obj as any).__glowTube) {
        this._returnGlowTube((saved.obj as any).__glowTube);
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

  /** Add a temporary highlight mesh for a batched face. */
  private _addBatchedHighlight(faceId: string, mode: 'selection' | 'preselection'): void {
    if (!this._batchedFaceHighlightFn || this._batchedHighlights.has(faceId)) return;
    const geo = this._batchedFaceHighlightFn(faceId);
    if (!geo) return;
    const mat = mode === 'selection' ? this._selHighlightFace : this._preSelHighlightFace;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `batched-highlight-${faceId}`;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this._scene.add(mesh);
    this._batchedHighlights.set(faceId, mesh);
  }

  /** Remove a specific batched highlight mesh. */
  private _removeBatchedHighlight(faceId: string): void {
    const mesh = this._batchedHighlights.get(faceId);
    if (mesh) {
      this._scene.remove(mesh);
      mesh.geometry.dispose();
      this._batchedHighlights.delete(faceId);
    }
  }

  /** Remove all batched highlight meshes. */
  private _clearBatchedHighlights(): void {
    for (const [, mesh] of this._batchedHighlights) {
      this._scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this._batchedHighlights.clear();
  }

  private _restoreHighlighted(): void {
    for (const [, { obj, origMaterial }] of this._highlightedObjects) {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        (obj as any).material = origMaterial;
      }
      // Return glow tubes to pool instead of disposing
      if ((obj as any).__glowTube) {
        this._returnGlowTube((obj as any).__glowTube);
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

  // Reusable objects for section plane (avoid allocation per call)
  private _sectionNormal = new THREE.Vector3();
  private _sectionPoint = new THREE.Vector3();
  private _sectionPlane = new THREE.Plane();

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
    const n = this._sectionNormal.set(normal.x, normal.y, normal.z).normalize();
    const constant = -n.dot(this._sectionPoint.set(point.x, point.y, point.z));
    const clipPlane = this._sectionPlane.set(n, constant);

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
