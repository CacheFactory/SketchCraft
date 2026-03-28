// @archigraph file.registry
// File format registry for SketchCraft

import * as NativeFormat from './NativeFormat';
import * as ObjFormat from './ObjFormat';
import * as StlFormat from './StlFormat';
import * as GltfFormat from './GltfFormat';
import * as DxfFormat from './DxfFormat';
import * as StepFormat from './StepFormat';
import * as FbxFormat from './FbxFormat';

// ─── Format Descriptor ──────────────────────────────────────────

export interface FileFormatDescriptor {
  /** Unique format identifier */
  id: string;
  /** Human-readable format name */
  name: string;
  /** File extensions (without dot), e.g. ['obj'] */
  extensions: string[];
  /** MIME types for this format */
  mimeTypes: string[];
  /** Whether import is supported */
  canImport: boolean;
  /** Whether export is supported */
  canExport: boolean;
  /** Whether the format is fully implemented or a stub */
  isStub: boolean;
  /** Description of any limitations */
  notes?: string;
}

// ─── Registry ───────────────────────────────────────────────────

export const FILE_FORMATS: FileFormatDescriptor[] = [
  {
    id: 'native',
    name: 'SketchCraft Native',
    extensions: ['sketch'],
    mimeTypes: ['application/x-sketchcraft'],
    canImport: true,
    canExport: true,
    isStub: false,
  },
  {
    id: 'obj',
    name: 'Wavefront OBJ',
    extensions: ['obj'],
    mimeTypes: ['model/obj', 'text/plain'],
    canImport: true,
    canExport: true,
    isStub: false,
  },
  {
    id: 'stl',
    name: 'STL (Stereolithography)',
    extensions: ['stl'],
    mimeTypes: ['model/stl', 'application/sla'],
    canImport: true,
    canExport: true,
    isStub: false,
  },
  {
    id: 'gltf',
    name: 'glTF 2.0 Binary',
    extensions: ['glb', 'gltf'],
    mimeTypes: ['model/gltf-binary', 'model/gltf+json'],
    canImport: true,
    canExport: true,
    isStub: false,
  },
  {
    id: 'dxf',
    name: 'AutoCAD DXF',
    extensions: ['dxf'],
    mimeTypes: ['application/dxf', 'image/vnd.dxf'],
    canImport: true,
    canExport: true,
    isStub: false,
  },
  {
    id: 'step',
    name: 'STEP (ISO 10303)',
    extensions: ['step', 'stp'],
    mimeTypes: ['application/step', 'model/step'],
    canImport: true,
    canExport: false,
    isStub: true,
    notes: 'Requires OpenCascade WASM module for import. Export not supported.',
  },
  {
    id: 'fbx',
    name: 'Autodesk FBX',
    extensions: ['fbx'],
    mimeTypes: ['application/octet-stream'],
    canImport: true,
    canExport: true,
    isStub: true,
    notes: 'Basic skeleton implementation. Full FBX requires Autodesk FBX SDK WASM.',
  },
];

/**
 * Look up a format descriptor by file extension.
 */
export function getFormatByExtension(ext: string): FileFormatDescriptor | undefined {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return FILE_FORMATS.find(f => f.extensions.includes(normalized));
}

/**
 * Look up a format descriptor by its ID.
 */
export function getFormatById(id: string): FileFormatDescriptor | undefined {
  return FILE_FORMATS.find(f => f.id === id);
}

/**
 * Get all formats that support import.
 */
export function getImportFormats(): FileFormatDescriptor[] {
  return FILE_FORMATS.filter(f => f.canImport);
}

/**
 * Get all formats that support export.
 */
export function getExportFormats(): FileFormatDescriptor[] {
  return FILE_FORMATS.filter(f => f.canExport);
}

/**
 * Build a file filter string for use in file dialogs.
 * Returns entries like "Wavefront OBJ (*.obj)"
 */
export function getFileFilterString(formats: FileFormatDescriptor[]): string {
  return formats
    .map(f => `${f.name} (${f.extensions.map(e => `*.${e}`).join(', ')})`)
    .join(';');
}

// ─── Re-exports ─────────────────────────────────────────────────

export { NativeFormat, ObjFormat, StlFormat, GltfFormat, DxfFormat, StepFormat, FbxFormat };
