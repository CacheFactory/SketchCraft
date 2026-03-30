// @archigraph renderer.viewport
// Viewport: owns canvas, renderer, and camera; handles resize and coordinate transforms

import * as THREE from 'three';
import { IViewport, IRenderer, ICameraController } from '../../src/core/interfaces';
import { Vec3, Vec2, RenderMode, ProjectionType } from '../../src/core/types';
import { WebGLRenderer } from '../renderer.webgl/WebGLRenderer';
import { CameraController } from '../camera.main/CameraController';

export class Viewport implements IViewport {
  renderer: IRenderer;
  camera: ICameraController;

  private _webglRenderer: WebGLRenderer;
  private _cameraController: CameraController;
  private _canvas: HTMLCanvasElement | null = null;
  private _container: HTMLElement | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _gridVisible = true;
  private _axesVisible = true;
  private _width = 1;
  private _height = 1;

  constructor() {
    this._cameraController = new CameraController();
    this._webglRenderer = new WebGLRenderer(this._cameraController);
    this.renderer = this._webglRenderer;
    this.camera = this._cameraController;
  }

  initialize(container: HTMLElement): void {
    this._container = container;

    this._canvas = document.createElement('canvas');
    this._canvas.style.display = 'block';
    this._canvas.tabIndex = 0;
    container.appendChild(this._canvas);

    const rect = container.getBoundingClientRect();
    this._width = rect.width;
    this._height = rect.height;

    this._webglRenderer.initialize(this._canvas, this._width, this._height);

    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this._width = width;
          this._height = height;
          this._webglRenderer.resize(width, height);
        }
      }
    });
    this._resizeObserver.observe(container);

    this._webglRenderer.startRenderLoop();
  }

  dispose(): void {
    this._webglRenderer.stopRenderLoop();
    this._webglRenderer.dispose();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._canvas && this._container) {
      this._container.removeChild(this._canvas);
      this._canvas = null;
    }
    this._container = null;
  }

  setRenderMode(mode: RenderMode): void { this._webglRenderer.setRenderMode(mode); }
  setProjection(type: ProjectionType): void { this._cameraController.setProjection(type); }

  toggleGrid(): void {
    this._gridVisible = !this._gridVisible;
    this._webglRenderer.setGridVisible(this._gridVisible);
  }

  toggleAxes(): void {
    this._axesVisible = !this._axesVisible;
    this._webglRenderer.setAxesVisible(this._axesVisible);
  }

  screenToWorld(screenX: number, screenY: number): Vec3 | null {
    const ray = this._cameraController.screenToRay(screenX, screenY, this._width, this._height);
    if (Math.abs(ray.direction.y) < 1e-10) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t < 0) return null;
    return {
      x: ray.origin.x + ray.direction.x * t,
      y: ray.origin.y + ray.direction.y * t,
      z: ray.origin.z + ray.direction.z * t,
    };
  }

  worldToScreen(point: Vec3): Vec2 {
    return this._cameraController.worldToScreen(point, this._width, this._height);
  }

  raycastScene(
    screenX: number,
    screenY: number,
  ): Array<{ entityId: string; point: Vec3; distance: number }> {
    // Use stored dimensions — they're set by ResizeObserver and match the
    // camera's aspect ratio exactly (both set from the same resize event).
    const w = this._width;
    const h = this._height;

    const ndc = new THREE.Vector2(
      (screenX / w) * 2 - 1,
      -(screenY / h) * 2 + 1,
    );

    // Get the Three.js camera and force ALL matrices to be current.
    // This is critical: after orbit/pan/zoom, the camera's position and
    // rotation are set via lookAt(), but matrixWorld and projectionMatrixInverse
    // may be stale until the next render. We must update them before raycasting.
    const camera = this._cameraController.getThreeCamera();
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
    // projectionMatrixInverse is needed by unproject() inside setFromCamera
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    const raycaster = new THREE.Raycaster();
    // Compute a line threshold that corresponds to a fixed number of screen pixels
    // regardless of zoom level. We convert ~10 pixels into world units at the
    // camera's current distance to its look-at target.
    const camTarget = (this._cameraController as any).target || { x: 0, y: 0, z: 0 };
    const camDist = camera.position.distanceTo(new THREE.Vector3(camTarget.x, camTarget.y, camTarget.z));
    let pixelSize: number;
    if (camera instanceof THREE.PerspectiveCamera) {
      // World units per pixel at target distance
      const vFov = (camera.fov * Math.PI) / 180;
      pixelSize = (2 * camDist * Math.tan(vFov / 2)) / h;
    } else {
      // Orthographic: world units per pixel
      const orthoH = ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom);
      pixelSize = orthoH / h;
    }
    const threshold = Math.max(0.01, pixelSize * 10); // ~10 screen pixels
    raycaster.params.Line = { threshold };
    raycaster.params.Points = { threshold };
    raycaster.setFromCamera(ndc, camera);

    // Raycast main scene (faces) AND overlay scene (edges)
    const scene = this._webglRenderer.getScene();
    const overlayScene = this._webglRenderer.getOverlayScene();
    const intersects = [
      ...raycaster.intersectObjects(scene.children, true),
      ...raycaster.intersectObjects(overlayScene.children, true),
    ];

    const faceHits: Array<{ entityId: string; point: Vec3; distance: number }> = [];
    const edgeHits: Array<{ entityId: string; point: Vec3; distance: number }> = [];
    const seenIds = new Set<string>();

    for (const hit of intersects) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        if (obj.userData.entityId) {
          const eid = obj.userData.entityId as string;
          if (!seenIds.has(eid)) {
            seenIds.add(eid);
            const entry = {
              entityId: eid,
              point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
              distance: hit.distance,
            };
            // Separate faces from edges — faces take priority
            if (obj.userData.entityType === 'edge' || hit.object instanceof THREE.Line) {
              edgeHits.push(entry);
            } else {
              faceHits.push(entry);
            }
          }
          break;
        }
        obj = obj.parent;
      }
    }

    // If an edge was hit, it means the cursor is very close to it
    // (within the Line threshold). Prioritize the edge over the face
    // so edges are actually selectable. If no edge hit, faces come first.
    if (edgeHits.length > 0) {
      return [...edgeHits, ...faceHits];
    }
    return faceHits;
  }

  getWidth(): number { return this._width; }
  getHeight(): number { return this._height; }

  getCanvas(): HTMLCanvasElement | null { return this._canvas; }
  getWebGLRenderer(): WebGLRenderer { return this._webglRenderer; }
  getCameraController(): CameraController { return this._cameraController; }
}
