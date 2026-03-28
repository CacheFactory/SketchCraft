// @archigraph renderer
// Re-exports for the renderer subsystem

export { WebGLRenderer } from './WebGLRenderer';
export { CameraController } from './CameraController';
export { Viewport } from './Viewport';

// Shaders
export { createOutlineShaderMaterial } from './shaders/OutlineShader';
export type { OutlineShaderUniforms } from './shaders/OutlineShader';

export {
  createSelectionOutlineMaterial,
  createSelectionOverlayMaterial,
  createPreSelectionMaterial,
  SELECTION_COLOR,
  PRE_SELECTION_COLOR,
} from './shaders/SelectionShader';

export {
  createXRayMaterial,
  createXRayBasicMaterial,
  createXRayWireframeMaterial,
} from './shaders/XRayShader';

export {
  createPBRMaterial,
  updatePBRMaterial,
  createDefaultPBRMaterial,
  disposeTextureCache,
} from './shaders/PBRShader';
